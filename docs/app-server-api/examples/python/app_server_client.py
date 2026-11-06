"""Small synchronous client shared by the advanced examples, with one receive loop."""

import argparse
from collections import deque
from concurrent.futures import Future
from contextlib import contextmanager
from dataclasses import dataclass
import json
import math
import socket
import sys
import time
from urllib.parse import urlsplit

import websocket

from app_server_ws import load_config


MAX_FRAME_BYTES = 8 * 1024 * 1024
# A bounded image admission can arrive as both item/started and item/completed
# while an unrelated RPC is pending. Keep both without enlarging single frames.
MAX_BUFFER_BYTES = 16 * 1024 * 1024
MAX_NOTIFICATIONS = 2048
MAX_SERVER_REQUESTS = 64
MAX_SEEN_REQUESTS = 4096
MAX_TEXT_ITEMS = 4096
MAX_TEXT_CHUNKS = 65536
SERVER_REQUEST_TIMEOUT = 60
OUTCOME_UNKNOWN = 'EXECUTION_UNKNOWN:'
COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
TOOL_INPUT = 'item/tool/requestUserInput'


class RpcError(RuntimeError):
    def __init__(self, method, error):
        self.method = method
        self.code = error.get('code')
        super().__init__(f"{method}: {error.get('message', 'RPC failed')}")


class TurnWaitTimeout(TimeoutError):
    def __init__(self, pending, partial_results):
        self.pending = set(pending)
        self.partial_results = dict(partial_results)
        super().__init__('Turn wait timed out; unfinished outcomes are unknown. Do not resend automatically.')


@dataclass(frozen=True)
class TurnResult:
    thread_id: str
    turn_id: str
    status: str
    error: dict | None
    text: str

    @property
    def outcome_unknown(self):
        return bool(self.error and str(self.error.get('message', '')).startswith(OUTCOME_UNKNOWN))

    @property
    def completed(self):
        return self.status == 'completed' and not self.outcome_unknown


def positive_timeout(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError('Use a positive finite timeout.') from None
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('Use a positive finite timeout.')
    return number


def print_notification(event):
    print(json.dumps(event, ensure_ascii=False), flush=True)


def print_turn_result(result):
    print_notification({'threadId': result.thread_id, 'turnId': result.turn_id,
        'status': result.status, 'error': result.error, 'text': result.text})


def run_cli(main):
    try:
        return main()
    except KeyboardInterrupt:
        print('Connection closed; cancellation of owned work is requested, not confirmed.', file=sys.stderr)
        return 130
    except TurnWaitTimeout as error:
        for result in error.partial_results.values():
            print_turn_result(result)
        print(str(error), file=sys.stderr)
        print_notification({'unfinishedTurns': [dict(threadId=thread, turnId=turn)
            for thread, turn in sorted(error.pending)]})
        return 1
    except (OSError, websocket.WebSocketException):
        # Library handshake errors can contain HTTP details; never dump them or headers.
        print('Connection failed or closed; submitted outcomes may be unknown. Do not resend automatically.', file=sys.stderr)
        return 1
    except (RuntimeError, ValueError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        return 1


class AppServerClient:
    """Use only from one thread. Approval workers return Futures and never touch sockets."""

    def __init__(self, connection, *, rpc_timeout=60, request_handler=None):
        self.connection = connection
        self.rpc_timeout = rpc_timeout
        self.request_handler = request_handler
        self._next_id = 0
        self._pending_rpc = {}
        self._responses = {}
        self._events = deque()
        self._buffer_bytes = 0
        self._server = {}
        self._seen_server = set()
        self._identity_bytes = 0
        self._owned_turns = set()
        self._finished_turns = set()
        self._closed = False
        self._call_deadline = None

    @property
    def is_closed(self):
        return self._closed

    def owns_turn(self, thread_id, turn_id):
        return (thread_id, turn_id) in self._owned_turns

    def _send(self, message):
        if self._closed:
            raise ConnectionError('The app-server connection is closed.')
        encoded = json.dumps(message, ensure_ascii=False)
        if len(encoded.encode('utf-8')) > MAX_FRAME_BYTES:
            raise ValueError('Outgoing message exceeds the example client limit.')
        timeout = self.rpc_timeout
        if self._call_deadline is not None:
            timeout = min(timeout, self._call_deadline - time.monotonic())
            if timeout <= 0:
                raise TimeoutError('RPC deadline expired; submitted outcomes may be unknown. Do not resend.')
        self.connection.settimeout(timeout)
        self.connection.send(encoded)

    def call(self, method, params=None, timeout=None):
        if self._pending_rpc:
            raise RuntimeError('Nested RPC calls are unsupported; return a Future from approval handlers.')
        budget = self.rpc_timeout if timeout is None else timeout
        if not math.isfinite(budget) or budget <= 0:
            raise ValueError('RPC timeout must be a positive finite number.')
        self._call_deadline = time.monotonic() + budget
        self._next_id += 1
        request_id = self._next_id
        params = {} if params is None else params
        self._pending_rpc[request_id] = (method, params)
        try:
            self._send({'id': request_id, 'method': method, 'params': params})
            while request_id not in self._responses:
                remaining = self._call_deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f'{method} timed out; any submitted work may be unknown. Do not resend.')
                self.pump(min(remaining, 0.2))
            response, size = self._responses.pop(request_id)
            self._buffer_bytes -= size
            if 'error' in response:
                if not isinstance(response['error'], dict):
                    raise ValueError('Expected an RPC error object.')
                raise RpcError(method, response['error'])
            result = response.get('result')
            if not isinstance(result, dict):
                raise ValueError('Expected an RPC result object.')
            return result
        finally:
            self._pending_rpc.pop(request_id, None)
            self._call_deadline = None

    def _reserve(self, size):
        if self._buffer_bytes + size > MAX_BUFFER_BYTES:
            raise RuntimeError('Buffered events exceeded the client limit; stop and reconcile without replaying.')
        self._buffer_bytes += size

    def _reply(self, request_id, *, result=None, error=None):
        entry = self._server.pop(request_id, None)
        if entry is None:
            return
        self._buffer_bytes -= entry['size']
        if entry.get('future'):
            entry['future'].cancel()
        self._send({'id': request_id, **({'error': error} if error is not None else {'result': result})})

    def _deny(self, request_id):
        entry = self._server.get(request_id)
        if entry is None:
            return
        method = entry['message']['method']
        if method == COMMAND_APPROVAL:
            self._reply(request_id, result={'decision': 'decline'})
        elif method == TOOL_INPUT:
            self._reply(request_id, result={'answers': {}})
        else:
            self._reply(request_id, error={'code': -32601, 'message': 'Unsupported server request.'})

    def _withdraw(self, request_id):
        entry = self._server.pop(request_id, None)
        if entry:
            self._buffer_bytes -= entry['size']
            if entry.get('future'):
                entry['future'].cancel()

    def _process_server_requests(self):
        if self._closed:
            return
        for request_id, entry in list(self._server.items()):
            message = entry['message']
            params = message.get('params', {})
            pair = (params.get('threadId'), params.get('turnId'))
            if time.monotonic() >= entry['deadline']:
                self._deny(request_id)
                continue
            if not self.owns_turn(*pair):
                opening = any(method == 'turn/start' and values.get('threadId') == pair[0]
                    for method, values in self._pending_rpc.values())
                if not opening:
                    self._deny(request_id)
                continue
            if 'future' not in entry:
                try:
                    answer = self.request_handler(message) if self.request_handler else None
                except Exception:
                    answer = None
                if isinstance(answer, Future):
                    entry['future'] = answer
                elif isinstance(answer, dict):
                    self._reply(request_id, result=answer)
                    continue
                else:
                    self._deny(request_id)
                    continue
            future = entry.get('future')
            if future and future.done():
                try:
                    answer = future.result()
                except Exception:
                    answer = None
                if isinstance(answer, dict):
                    self._reply(request_id, result=answer)
                else:
                    self._deny(request_id)

    def _dispatch(self, message, size):
        method = message.get('method')
        if isinstance(method, str) and 'id' in message:
            request_id = message['id']
            if not isinstance(request_id, (int, str)) or isinstance(request_id, bool):
                raise ValueError('Invalid server request ID.')
            if request_id in self._seen_server:
                return
            if len(self._server) >= MAX_SERVER_REQUESTS or len(self._seen_server) >= MAX_SEEN_REQUESTS:
                raise RuntimeError('Too many server requests; close and reconcile instead of replaying.')
            identity_bytes = len(str(request_id).encode('utf-8'))
            if self._identity_bytes + identity_bytes > MAX_BUFFER_BYTES:
                raise RuntimeError('Server request identities exceeded the client limit.')
            if not isinstance(message.get('params', {}), dict):
                raise ValueError('Invalid server request parameters.')
            self._reserve(size)
            self._seen_server.add(request_id)
            self._identity_bytes += identity_bytes
            self._server[request_id] = {'message': message, 'size': size,
                'deadline': time.monotonic() + SERVER_REQUEST_TIMEOUT}
        elif isinstance(method, str):
            params = message.get('params', {})
            if not isinstance(params, dict):
                raise ValueError('Invalid notification parameters.')
            if method == 'serverRequest/resolved':
                self._withdraw(params.get('requestId'))
            if method == 'turn/completed':
                if not isinstance(params.get('turn'), dict):
                    raise ValueError('Invalid turn completion notification.')
                pair = (params.get('threadId'), params.get('turnId'))
                if params['turn'].get('id') == pair[1]:
                    opening = any(name == 'turn/start' and values.get('threadId') == pair[0]
                        for name, values in self._pending_rpc.values())
                    if self.owns_turn(*pair) or opening:
                        if not all(isinstance(value, str) and value for value in pair):
                            raise ValueError('Invalid completed turn identity.')
                        if pair not in self._finished_turns:
                            identity_bytes = sum(len(value.encode('utf-8')) for value in pair)
                            if len(self._finished_turns) >= MAX_SEEN_REQUESTS or self._identity_bytes + identity_bytes > MAX_BUFFER_BYTES:
                                raise RuntimeError('Completed turn identities exceeded the client limit.')
                            self._finished_turns.add(pair)
                            self._identity_bytes += identity_bytes
                    self._owned_turns.discard(pair)
                    for request_id, entry in list(self._server.items()):
                        pending = entry['message'].get('params', {})
                        if (pending.get('threadId'), pending.get('turnId')) == pair:
                            self._withdraw(request_id)
            if len(self._events) >= MAX_NOTIFICATIONS:
                raise RuntimeError('Notification queue exceeded its limit; no events were silently dropped.')
            self._reserve(size)
            self._events.append((message, size))
        elif isinstance(message.get('id'), int) and not isinstance(message.get('id'), bool) and message['id'] in self._pending_rpc and message['id'] not in self._responses:
            request_id = message['id']
            if ('result' in message) == ('error' in message):
                raise ValueError('Invalid RPC response envelope.')
            method, params = self._pending_rpc[request_id]
            result = message.get('result')
            if method == 'turn/start' and isinstance(result, dict):
                turn = result.get('turn', {})
                if isinstance(turn, dict) and isinstance(turn.get('id'), str):
                    pair = (params.get('threadId'), turn['id'])
                    if pair not in self._finished_turns:
                        self._owned_turns.add(pair)
            self._reserve(size)
            self._responses[request_id] = (message, size)

    def pump(self, timeout=0.2):
        if self._closed:
            raise ConnectionError('The app-server connection is closed.')
        self.connection.settimeout(max(0.001, min(timeout, 0.2)))
        received = False
        try:
            raw = self.connection.recv()
            if not raw:
                raise ConnectionError('The app-server connection closed; do not replay uncertain work.')
            if not isinstance(raw, str) or len(raw.encode('utf-8')) > MAX_FRAME_BYTES:
                raise ValueError('Invalid or oversized app-server frame.')
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise ValueError('Expected a JSON object from app-server.')
            self._dispatch(message, len(raw.encode('utf-8')))
            received = True
        except websocket.WebSocketTimeoutException:
            pass
        self._process_server_requests()
        return received

    def next_notification(self, timeout):
        deadline = time.monotonic() + timeout
        while not self._events:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('No notification arrived before the observation deadline.')
            self.pump(min(remaining, 0.2))
        message, size = self._events.popleft()
        self._buffer_bytes -= size
        return message

    def wait_turns(self, pairs, *, timeout=300, on_event=None):
        pending = set(pairs)
        results = {}
        texts = {pair: {} for pair in pending}
        sizes = {}
        text_bytes = 0
        chunk_count = 0
        deadline = time.monotonic() + timeout
        while pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TurnWaitTimeout(pending, results)
            try:
                event = self.next_notification(remaining)
            except TimeoutError:
                raise TurnWaitTimeout(pending, results) from None
            params = event.get('params', {})
            pair = (params.get('threadId'), params.get('turnId'))
            if pair not in pending:
                continue
            method = event['method']
            if method == 'turn/completed' and params.get('turn', {}).get('id') != pair[1]:
                continue
            if on_event:
                on_event(event)
            item = params.get('item', {})
            if not isinstance(item, dict):
                raise ValueError('Invalid item notification.')
            item_id = params.get('itemId') if method == 'item/agentMessage/delta' else item.get('id')
            delta = params.get('delta') if method == 'item/agentMessage/delta' else None
            snapshot = item.get('text') if method == 'item/completed' and item.get('type') == 'agentMessage' else None
            if isinstance(item_id, str) and (isinstance(delta, str) or isinstance(snapshot, str)):
                key = (pair, item_id)
                previous = sizes.get(key, 0)
                old_chunks = texts[pair].get(item_id, [])
                if snapshot == '':
                    if key in sizes:
                        text_bytes -= previous + len(item_id.encode('utf-8'))
                        chunk_count -= len(old_chunks)
                        del sizes[key]
                        texts[pair].pop(item_id, None)
                    continue
                if snapshot is None and not delta:
                    continue
                is_new = key not in sizes
                if is_new and len(sizes) >= MAX_TEXT_ITEMS:
                    raise RuntimeError('Too many assistant items for the example client.')
                current = len(snapshot.encode('utf-8')) if snapshot is not None else previous + len(delta.encode('utf-8'))
                next_bytes = text_bytes + current - previous + (len(item_id.encode('utf-8')) if is_new else 0)
                next_chunks = chunk_count - len(old_chunks) + 1 if snapshot is not None else chunk_count + 1
                if next_bytes > MAX_BUFFER_BYTES or next_chunks > MAX_TEXT_CHUNKS:
                    raise RuntimeError('Turn text exceeded the example client buffer limit.')
                text_bytes = next_bytes
                chunk_count = next_chunks
                chunks = [snapshot] if snapshot is not None else old_chunks
                if snapshot is None:
                    chunks.append(delta)
                texts[pair][item_id] = chunks
                sizes[key] = current
            if method == 'turn/completed':
                turn = params['turn']
                results[pair] = TurnResult(*pair, turn.get('status', 'unknown'), turn.get('error'),
                    '\n'.join(''.join(chunks) for chunks in texts[pair].values()))
                pending.remove(pair)
        return results

    def close(self):
        if self._closed:
            return
        self._closed = True
        for request_id in list(self._server):
            self._withdraw(request_id)
        self._events.clear()
        self._responses.clear()
        self._owned_turns.clear()
        self._finished_turns.clear()
        self.connection.close()


@contextmanager
def open_client(config_path, *, client_name='python-advanced-example', experimental=False,
        request_handler=None, rpc_timeout=60):
    url, headers = load_config(config_path)
    with socket.create_connection(('127.0.0.1', urlsplit(url).port), timeout=rpc_timeout) as transport:
        connection = websocket.create_connection(url, socket=transport, header=headers,
            suppress_origin=True, redirect_limit=0, timeout=rpc_timeout)
        client = AppServerClient(connection, rpc_timeout=rpc_timeout, request_handler=request_handler)
        try:
            client.call('initialize', {'clientInfo': {'name': client_name, 'version': '1.0.0'},
                'capabilities': {'experimentalApi': experimental}})
            client._send({'method': 'initialized'})
            yield client
        finally:
            client.close()
