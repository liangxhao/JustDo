import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import subscribe


class FakeClient:
    def __init__(self, notifications=(), unsubscribe_error=None):
        self.notifications = iter(notifications)
        self.unsubscribe_error = unsubscribe_error
        self.calls = []
        self.is_closed = False
        self.close_count = 0

    def call(self, method, params=None, timeout=None):
        self.calls.append((method, params, timeout))
        if method == 'thread/resume':
            return {'thread': {'id': params['threadId']}}
        if self.unsubscribe_error:
            raise self.unsubscribe_error
        return {'status': 'unsubscribed'}

    def next_notification(self, timeout):
        self.assert_positive_wait(timeout)
        reply = next(self.notifications, TimeoutError('Observation ended'))
        if isinstance(reply, BaseException):
            raise reply
        return reply

    @staticmethod
    def assert_positive_wait(timeout):
        if timeout <= 0:
            raise AssertionError('Expected a positive observation wait.')

    def close(self):
        self.close_count += 1
        self.is_closed = True


class SubscribeTests(unittest.TestCase):
    def args(self):
        return subscribe.parse_args(['--config', 'copied-connection.json', '--thread-id', 'thread', '--timeout', '1'])

    def test_observes_buffered_matching_events_and_keeps_watching_after_a_terminal(self):
        first = {'method': 'item/agentMessage/delta', 'params': {'threadId': 'thread', 'turnId': 'owned-elsewhere', 'delta': 'hello'}}
        terminal = {'method': 'turn/completed', 'params': {'threadId': 'thread', 'turnId': 'owned-elsewhere', 'turn': {'id': 'owned-elsewhere', 'status': 'completed'}}}
        later = {'method': 'turn/started', 'params': {'threadId': 'thread', 'turnId': 'later-turn'}}
        foreign = {'method': 'thread/status/changed', 'params': {'threadId': 'foreign', 'status': {'type': 'active'}}}
        client = FakeClient([first, foreign, terminal, later])
        output = []
        with patch.object(subscribe, 'print_notification', output.append), contextlib.redirect_stderr(io.StringIO()):
            code = subscribe.run(client, self.args())
        self.assertEqual(code, 0)
        self.assertEqual(output, [first, terminal, later])
        self.assertEqual(client.calls, [
            ('thread/resume', {'threadId': 'thread', 'excludeTurns': True}, None),
            ('thread/unsubscribe', {'threadId': 'thread'}, 5.0),
        ])
        self.assertEqual(client.close_count, 0)  # The connection context owns close.

    def test_ctrl_c_unsubscribes_without_issuing_an_interrupt(self):
        client = FakeClient([KeyboardInterrupt()])
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                subscribe.run(client, self.args())
        self.assertEqual([call[0] for call in client.calls], ['thread/resume', 'thread/unsubscribe'])

    def test_cleanup_failure_does_not_replace_the_observation_error(self):
        client = FakeClient([ConnectionError('Observation connection lost')], RuntimeError('Unsubscribe failed'))
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(ConnectionError, 'Observation connection lost'):
                subscribe.run(client, self.args())
        self.assertEqual(client.calls[-1], ('thread/unsubscribe', {'threadId': 'thread'}, 5.0))

    def test_a_first_ctrl_c_during_unsubscribe_still_reaches_the_cli_handler(self):
        client = FakeClient(unsubscribe_error=KeyboardInterrupt())
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                subscribe.run(client, self.args())
        self.assertEqual([call[0] for call in client.calls], ['thread/resume', 'thread/unsubscribe'])

    def test_the_outer_context_closes_the_observer_after_a_normal_timeout(self):
        client = FakeClient()
        args = self.args()

        @contextlib.contextmanager
        def opened(*args, **kwargs):
            try:
                yield client
            finally:
                client.close()

        with patch.object(subscribe, 'parse_args', return_value=args), patch.object(subscribe, 'open_client', opened), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(subscribe.main(), 0)
        self.assertEqual(client.close_count, 1)
        self.assertEqual([call[0] for call in client.calls], ['thread/resume', 'thread/unsubscribe'])


if __name__ == '__main__':
    unittest.main()
