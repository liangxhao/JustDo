#!/usr/bin/env python3
"""Call the desktop app-server over its native-client WebSocket endpoint."""

import argparse
from contextlib import closing
import json
import math
from pathlib import Path
import re
import socket
import sys
import time
from urllib.parse import urlsplit

import websocket


RPC_TIMEOUT = 60
TURN_TIMEOUT = 300
TEXT_DELTA = 'item/agentMessage/delta'
ITEM_COMPLETED = 'item/completed'
TURN_COMPLETED = 'turn/completed'
OUTCOME_UNKNOWN = 'EXECUTION_UNKNOWN:'


def load_config(path: str) -> tuple[str, dict[str, str]]:
    # utf-8-sig also accepts files saved with a BOM by Windows PowerShell.
    try:
        config = json.loads(Path(path).read_text(encoding='utf-8-sig'))
        url = config['url']
        authorization = config['headers']['Authorization']
        address = urlsplit(url)
        valid_url = (
            address.scheme == 'ws'
            and address.hostname == '127.0.0.1'
            and address.port is not None
            and 1 <= address.port <= 65535
            and address.path == '/app-server'
            and address.username is None
            and address.password is None
            and not address.query
            and not address.fragment
        )
        if not valid_url or not re.fullmatch(r'Bearer [^\s]+', authorization):
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise ValueError('Use the WebSocket connection JSON copied from desktop settings.') from None
    # Never print the config or enable websocket.enableTrace: it exposes the token.
    return url, {'Authorization': authorization}


class AppServerClient:
    """One connection, one thread, sequential RPC calls followed by turn events."""

    def __init__(self, connection: websocket.WebSocket):
        self.connection = connection
        self.next_id = 0

    def receive(self, deadline: float) -> dict:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Timed out waiting for app-server.')
        self.connection.settimeout(remaining)
        raw = self.connection.recv()
        if not raw:
            raise ConnectionError('The app-server connection closed.')
        message = json.loads(raw)
        if not isinstance(message, dict):
            raise ValueError('Expected a JSON object from app-server.')
        return message

    def call(self, method: str, params: dict) -> dict:
        self.next_id += 1
        request_id = self.next_id
        self.connection.settimeout(RPC_TIMEOUT)
        self.connection.send(json.dumps({
            'id': request_id,
            'method': method,
            'params': params,
        }, ensure_ascii=False))
        deadline = time.monotonic() + RPC_TIMEOUT
        while True:
            message = self.receive(deadline)
            if self.reject_server_request(message):
                continue
            if message.get('id') != request_id:
                continue  # Ignore unknown notifications/response IDs.
            if 'error' in message:
                error = message['error']
                raise RuntimeError(f"{method}: {error.get('message', 'RPC failed')}")
            return message['result']

    def reject_server_request(self, message: dict) -> bool:
        if 'id' not in message or not isinstance(message.get('method'), str):
            return False
        method = message['method']
        if method == 'item/commandExecution/requestApproval':
            response = {'id': message['id'], 'result': {'decision': 'decline'}}
        elif method == 'item/tool/requestUserInput':
            response = {'id': message['id'], 'result': {'answers': {}}}
        else:
            response = {'id': message['id'], 'error': {
                'code': -32601, 'message': 'This example does not implement this server request.',
            }}
        # A real client must present the exact request to its user before granting it.
        print(f'Client approval required ({method}); this example denies it.', file=sys.stderr)
        self.connection.send(json.dumps(response, ensure_ascii=False))
        return True

    def stream_turn(self, thread_id: str, turn_id: str, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        streamed_items = set()
        while True:
            message = self.receive(deadline)
            if self.reject_server_request(message):
                continue
            params = message.get('params', {})
            # Events and completion must belong to this exact thread AND turn.
            if params.get('threadId') != thread_id or params.get('turnId') != turn_id:
                continue
            method = message.get('method')
            if method == TEXT_DELTA:
                delta = params.get('delta', '')
                if delta:
                    streamed_items.add(params['itemId'])
                    print(delta, end='', flush=True)
            elif method == ITEM_COMPLETED:
                item = params.get('item', {})
                if item.get('type') == 'agentMessage':
                    # Completed text is a snapshot, not another delta.
                    if item['id'] not in streamed_items:
                        print(item.get('text', ''), end='', flush=True)
                    print(flush=True)
            elif method == TURN_COMPLETED:
                turn = params['turn']
                if turn.get('id') != turn_id:
                    continue
                status = turn.get('status')
                print(f'\nTurn status: {status}', file=sys.stderr)
                if status == 'completed':
                    return 0
                error = turn.get('error') or {}
                detail = error.get('message', '')
                if detail:
                    print(detail, file=sys.stderr)
                if detail.startswith(OUTCOME_UNKNOWN):
                    print('Execution outcome is unknown; do not resend automatically.', file=sys.stderr)
                elif status == 'failed':
                    print('Execution or output verification failed; do not retry automatically.', file=sys.stderr)
                return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='JSON copied from desktop WebSocket settings')
    parser.add_argument('--message', help='Text to send to the assistant')
    parser.add_argument('--list-models', action='store_true', help='List models and exit without creating a thread')
    parser.add_argument('--model', help='Model ID from --list-models; otherwise use the desktop default')
    parser.add_argument('--cwd', help='Absolute working directory on the desktop app machine')
    parser.add_argument('--thread-id', help='Explicitly resume a CLI/ACP/app-server external thread ID')
    parser.add_argument('--timeout', type=float, default=TURN_TIMEOUT, help='Whole-turn wait limit in seconds (default: 300)')
    args = parser.parse_args()
    if not args.list_models and (not args.message or not args.message.strip()):
        parser.error('--message is required unless --list-models is used')
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be a positive finite number')

    try:
        url, headers = load_config(args.config)
        # Use a direct loopback socket so system HTTP proxies cannot intercept it.
        with (
            socket.create_connection(('127.0.0.1', urlsplit(url).port), timeout=RPC_TIMEOUT) as transport,
            closing(websocket.create_connection(
                url,
                socket=transport,
                header=headers,
                suppress_origin=True,  # Native-client endpoint rejects ANY Origin header.
                redirect_limit=0,
                timeout=RPC_TIMEOUT,
            )) as connection,
        ):
            client = AppServerClient(connection)
            client.call('initialize', {
                'clientInfo': {'name': 'python-websocket-example', 'version': '1.0.0'},
            })
            # Complete the official handshake before sending business requests.
            connection.send(json.dumps({'method': 'initialized', 'params': {}}))
            # The protocol omits the "jsonrpc" field on the wire.
            models = client.call('model/list', {})
            if args.list_models:
                print(json.dumps(models, ensure_ascii=False, indent=2))
                return 0

            options = {}
            if args.cwd is not None:
                options['cwd'] = args.cwd
            if args.model is not None:
                options['model'] = args.model
            method = 'thread/start'
            if args.thread_id is not None:
                method = 'thread/resume'
                options['threadId'] = args.thread_id
                options['excludeTurns'] = True  # This streaming example does not render past turns.
            opened = client.call(method, options)
            thread_id = opened['thread']['id']
            print(f'Thread ID: {thread_id}', file=sys.stderr, flush=True)

            # The response is admission only. Keep reading until turn/completed.
            started = client.call('turn/start', {
                'threadId': thread_id,
                'input': [{'type': 'text', 'text': args.message}],
            })
            turn_id = started['turn']['id']
            print(f'Turn ID: {turn_id}', file=sys.stderr, flush=True)
            return client.stream_turn(thread_id, turn_id, args.timeout)
    except KeyboardInterrupt:
        print('\nConnection closed; cancellation is requested, but not confirmed.', file=sys.stderr)
        return 130
    except (TimeoutError, websocket.WebSocketTimeoutException):
        print('Timed out; execution may have started. Do not resend automatically.', file=sys.stderr)
        return 1
    except (OSError, websocket.WebSocketException):
        print('Connection failed or closed. Check the current desktop connection config. '
              'Any submitted execution outcome may be unknown; do not resend automatically.', file=sys.stderr)
        return 1
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
