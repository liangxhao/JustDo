import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import history


class FakeClient:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    def call(self, method, params=None, timeout=None):
        self.calls.append((method, params))
        reply = next(self.replies)
        if isinstance(reply, BaseException):
            raise reply
        return reply


class HistoryTests(unittest.TestCase):
    def args(self, *values):
        return history.parse_args(['--config', 'copied-connection.json', *values])

    def test_directory_stops_at_the_page_budget_and_keeps_the_continuation(self):
        client = FakeClient([
            {'data': [{'id': 'one'}], 'nextCursor': 'second'},
            {'data': [{'id': 'two'}], 'nextCursor': 'third'},
        ])
        output = []
        with patch.object(history, 'print_notification', output.append):
            code = history.run(client, self.args('--limit', '2', '--pages', '2', '--cursor', 'saved'))
        self.assertEqual(code, 0)
        self.assertEqual(client.calls, [
            ('thread/list', {'limit': 2, 'cursor': 'saved'}),
            ('thread/list', {'limit': 2, 'cursor': 'second'}),
        ])
        self.assertEqual(output[-1]['result']['nextCursor'], 'third')
        self.assertEqual(output[-1]['page'], 2)

    def test_items_preserve_the_exact_turn_filter_and_end_at_the_last_page(self):
        client = FakeClient([{'data': [{'turnId': 'turn'}], 'nextCursor': None}])
        with patch.object(history, 'print_notification'):
            history.run(client, self.args('--thread-id', 'thread', '--view', 'items', '--turn-id', 'turn', '--pages', '8'))
        self.assertEqual(client.calls, [
            ('thread/items/list', {'limit': 50, 'threadId': 'thread', 'turnId': 'turn'}),
        ])

    def test_turn_pages_request_a_summary_without_resuming(self):
        client = FakeClient([{'data': [], 'nextCursor': None}])
        with patch.object(history, 'print_notification'):
            history.run(client, self.args('--thread-id', 'thread'))
        self.assertEqual(client.calls, [
            ('thread/turns/list', {'limit': 50, 'threadId': 'thread', 'itemsView': 'summary'}),
        ])

    def test_full_history_uses_one_read_without_subscribing_or_executing(self):
        client = FakeClient([{'thread': {'id': 'thread', 'turns': []}}])
        output = []
        with patch.object(history, 'print_notification', output.append):
            history.run(client, self.args('--thread-id', 'thread', '--view', 'full', '--pages', '5'))
        self.assertEqual(client.calls, [('thread/read', {'threadId': 'thread', 'includeTurns': True})])
        self.assertEqual(output[0]['method'], 'thread/read')

    def test_an_invalidated_cursor_fails_without_restarting_or_replaying(self):
        client = FakeClient([
            {'data': [{'id': 'one'}], 'nextCursor': 'now-invalid'},
            RuntimeError('History changed; pagination cursor is invalid.'),
        ])
        output = []
        with patch.object(history, 'print_notification', output.append):
            with self.assertRaisesRegex(RuntimeError, 'History changed'):
                history.run(client, self.args('--thread-id', 'thread', '--pages', '3'))
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[1][1]['cursor'], 'now-invalid')
        self.assertEqual(len(output), 1)

    def test_invalid_view_combinations_fail_before_connecting(self):
        for arguments in [
            ['--view', 'items'],
            ['--thread-id', 'thread', '--turn-id', 'turn'],
            ['--thread-id', 'thread', '--view', 'full', '--cursor', 'opaque'],
        ]:
            with self.subTest(arguments=arguments), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    self.args(*arguments)
                self.assertEqual(raised.exception.code, 2)


if __name__ == '__main__':
    unittest.main()
