import json
from concurrent.futures import Future
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app_server_client as api
import websocket


class FakeSocket:
    def __init__(self, messages=()):
        self.messages = list(messages)
        self.sent = []
        self.timeout = None
        self.send_timeout = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeout = timeout

    def send(self, message):
        self.send_timeout = self.timeout
        self.sent.append(json.loads(message))

    def recv(self):
        if not self.messages:
            raise websocket.WebSocketTimeoutException()
        return json.dumps(self.messages.pop(0))

    def close(self):
        self.closed = True


def event(method, thread='thread', turn_id='turn', **params):
    return {'method': method, 'params': {'threadId': thread, 'turnId': turn_id, **params}}


def terminal(thread='thread', turn='turn', status='completed', error=None):
    return event('turn/completed', thread, turn, turn={'id': turn, 'status': status, 'error': error})


def approval(request_id='permission', thread='thread', turn='turn'):
    return {'id': request_id, 'method': api.COMMAND_APPROVAL,
        'params': {'threadId': thread, 'turnId': turn, 'command': 'echo example'}}


class ClientTests(unittest.TestCase):
    def start(self, messages, handler=None):
        socket = FakeSocket(messages)
        client = api.AppServerClient(socket, request_handler=handler)
        return client, socket

    def test_rpc_wait_retains_early_notifications_and_ignores_unknown_response_ids(self):
        early = event('item/agentMessage/delta', itemId='answer', delta='hello')
        client, _ = self.start([{'id': 999, 'result': {}}, early, {'id': 1, 'result': {'ok': True}}])
        self.assertEqual(client.call('model/list'), {'ok': True})
        self.assertEqual(client.next_notification(1), early)

    def test_rpc_wait_keeps_both_large_image_admission_items_without_raising_frame_limit(self):
        image = 'data:image/png;base64,' + 'A' * (4 * ((4 * 1024 * 1024 + 2) // 3))
        item = {'id': 'input-image', 'type': 'userMessage', 'content': [{'type': 'image', 'url': image}]}
        started = event('item/started', item=item)
        completed = event('item/completed', item=item)
        client, _ = self.start([started, completed, {'id': 1, 'result': {'data': []}}])
        self.assertEqual(client.call('model/list'), {'data': []})
        self.assertEqual(client.next_notification(1), started)
        self.assertEqual(client.next_notification(1), completed)
        self.assertEqual(client._buffer_bytes, 0)
        self.assertEqual(api.MAX_FRAME_BYTES, 8 * 1024 * 1024)

    def test_multiple_turns_complete_during_later_admission_without_duplicate_final_text(self):
        client, _ = self.start([
            {'id': 1, 'result': {'turn': {'id': 'first'}}},
            event('item/agentMessage/delta', turn_id='first', itemId='answer', delta='part'),
            event('item/completed', turn_id='first', item={'id': 'answer', 'type': 'agentMessage', 'text': 'complete'}),
            terminal(turn='first'),
            {'id': 2, 'result': {'turn': {'id': 'second'}}},
            event('item/agentMessage/delta', thread='other', turn_id='second', itemId='foreign', delta='wrong'),
            event('turn/completed', turn_id='second', turn={'id': 'wrong', 'status': 'completed'}),
            terminal(turn='second', status='failed', error={'message': 'EXECUTION_UNKNOWN: check before retry'}),
        ])
        client.call('turn/start', {'threadId': 'thread'})
        client.call('turn/start', {'threadId': 'thread'})
        results = client.wait_turns([('thread', 'first'), ('thread', 'second')], timeout=1)
        self.assertEqual(results[('thread', 'first')].text, 'complete')
        self.assertTrue(results[('thread', 'first')].completed)
        self.assertTrue(results[('thread', 'second')].outcome_unknown)
        self.assertFalse(results[('thread', 'second')].completed)

    def test_completion_before_admission_response_never_revives_approval_ownership(self):
        presented = []
        client, socket = self.start([terminal(), {'id': 1, 'result': {'turn': {'id': 'turn'}}}, approval()],
            lambda request: presented.append(request) or {'decision': 'accept'})
        client.call('turn/start', {'threadId': 'thread'})
        self.assertFalse(client.owns_turn('thread', 'turn'))
        client.pump()
        self.assertEqual(presented, [])
        self.assertEqual(socket.sent[-1], {'id': 'permission', 'result': {'decision': 'decline'}})

    def test_approval_before_admission_response_waits_for_the_exact_returned_turn(self):
        presented = []
        client, socket = self.start([approval(), {'id': 1, 'result': {'turn': {'id': 'turn'}}}],
            lambda request: presented.append(request) or {'decision': 'accept'})
        client.call('turn/start', {'threadId': 'thread'})
        self.assertEqual(len(presented), 1)
        self.assertEqual(socket.sent[-1], {'id': 'permission', 'result': {'decision': 'accept'}})

    def test_future_wait_keeps_receiving_and_resolved_request_cannot_send_late_accept(self):
        future = Future()
        client, socket = self.start([{'id': 1, 'result': {'turn': {'id': 'turn'}}}, approval(),
            event('item/agentMessage/delta', itemId='answer', delta='still receiving'),
            {'method': 'serverRequest/resolved', 'params': {'requestId': 'permission', 'threadId': 'thread'}}],
            lambda _: future)
        client.call('turn/start', {'threadId': 'thread'})
        client.pump()
        self.assertFalse(future.done())
        self.assertEqual(client.next_notification(1)['params']['delta'], 'still receiving')
        client.pump()
        self.assertTrue(future.cancelled())
        self.assertFalse(any(message.get('id') == 'permission' for message in socket.sent))

    def test_close_cancels_pending_approval_and_duplicate_id_never_prompts_twice(self):
        future = Future()
        presented = []
        client, socket = self.start([{'id': 1, 'result': {'turn': {'id': 'turn'}}}, approval(), approval()],
            lambda request: presented.append(request) or future)
        client.call('turn/start', {'threadId': 'thread'})
        client.pump()
        client.pump()
        self.assertEqual(len(presented), 1)
        client.close()
        self.assertTrue(future.cancelled())
        self.assertTrue(socket.closed)

    def test_timed_out_server_request_declines_and_cancels_its_future(self):
        future = Future()
        client, socket = self.start([{'id': 1, 'result': {'turn': {'id': 'turn'}}}, approval()], lambda _: future)
        client.call('turn/start', {'threadId': 'thread'})
        client.pump()
        self.assertFalse(future.done())
        expires = client._server['permission']['deadline']
        with patch.object(api.time, 'monotonic', return_value=expires + 1):
            client.pump()
        self.assertEqual(socket.sent[-1]['result'], {'decision': 'decline'})
        self.assertTrue(future.cancelled())

    def test_rpc_send_uses_the_total_call_budget(self):
        client, socket = self.start([{'id': 1, 'result': {}}])
        client.call('thread/unsubscribe', {'threadId': 'thread'}, timeout=0.5)
        self.assertGreater(socket.send_timeout, 0)
        self.assertLessEqual(socket.send_timeout, 0.5)

    def test_queue_overflow_is_explicit_instead_of_silently_losing_a_terminal(self):
        client, _ = self.start([event('thread/status/changed'), terminal()])
        with patch.object(api, 'MAX_NOTIFICATIONS', 1):
            client.pump()
            with self.assertRaisesRegex(RuntimeError, 'Notification queue'):
                client.pump()

    def test_empty_deltas_and_snapshots_cannot_consume_unbounded_item_slots(self):
        client, _ = self.start([event('item/agentMessage/delta', itemId='one', delta=''),
            event('item/completed', item={'id': 'two', 'type': 'agentMessage', 'text': ''}),
            event('item/agentMessage/delta', itemId='real', delta='value'), terminal()])
        with patch.object(api, 'MAX_TEXT_ITEMS', 1):
            self.assertEqual(client.wait_turns([('thread', 'turn')], timeout=1)[('thread', 'turn')].text, 'value')

    def test_text_fragment_limit_cannot_be_bypassed_by_tiny_deltas(self):
        client, _ = self.start([event('item/agentMessage/delta', itemId='one', delta='a'),
            event('item/agentMessage/delta', itemId='one', delta='b')])
        with patch.object(api, 'MAX_TEXT_CHUNKS', 1):
            with self.assertRaisesRegex(RuntimeError, 'Turn text'):
                client.wait_turns([('thread', 'turn')], timeout=1)

    def test_wait_timeout_preserves_completed_results_without_inventing_pending_outcomes(self):
        client, _ = self.start([terminal(turn='done')])
        with self.assertRaises(api.TurnWaitTimeout) as caught:
            client.wait_turns([('thread', 'done'), ('thread', 'pending')], timeout=0.01)
        self.assertEqual(caught.exception.pending, {('thread', 'pending')})
        self.assertTrue(caught.exception.partial_results[('thread', 'done')].completed)


if __name__ == '__main__':
    unittest.main()
