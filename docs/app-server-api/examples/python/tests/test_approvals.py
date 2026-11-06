"""Local approval UI tests; no desktop connection, model, or credentials."""

from concurrent.futures import Future
from copy import deepcopy
import io
from pathlib import Path
import sys
from threading import Event
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from approvals import COMMAND_APPROVAL, TOOL_INPUT, InteractiveApprovals


def command_request(**overrides) -> dict:
    params = {
        'threadId': 'thread-1', 'turnId': 'turn-1', 'itemId': 'tool-1',
        'kind': 'command', 'command': 'echo hello', 'cwd': 'E:\\project',
        'reason': 'This command needs confirmation.',
    }
    params.update(overrides)
    return {'id': 'server-request:1', 'method': COMMAND_APPROVAL, 'params': params}


def plugin_request() -> dict:
    return {'id': 'server-request:2', 'method': TOOL_INPUT, 'params': {
        'threadId': 'thread-1', 'turnId': 'turn-1', 'itemId': 'tool-2',
        'isBlocking': True,
        'questions': [{
            'id': 'permission', 'header': '工具权限', 'question': '执行本次插件操作？',
            'isOther': False, 'isSecret': False,
            'options': [
                {'label': '仅允许一次', 'description': '只执行本次操作'},
                {'label': '拒绝', 'description': '拒绝本次操作'},
            ],
        }],
    }}


class InteractiveApprovalsTests(unittest.TestCase):
    def setUp(self):
        self.handlers = []

    def tearDown(self):
        for handler in self.handlers:
            handler.close()
            if handler._worker is not None:
                handler._worker.join(timeout=1)
                self.assertFalse(handler._worker.is_alive(), 'Test must release its stdin worker')

    def handler(self, line='accept\n', **options) -> InteractiveApprovals:
        result = InteractiveApprovals(
            options.pop('owns_turn', lambda thread, turn: (thread, turn) == ('thread-1', 'turn-1')),
            read_line=options.pop('read_line', lambda: line), output=options.pop('output', io.StringIO()),
            **options,
        )
        self.handlers.append(result)
        return result

    def resolve(self, handler, request) -> dict:
        response = handler(request)
        return response.result(timeout=1) if isinstance(response, Future) else response

    def test_command_requires_explicit_one_time_choice(self):
        for line, expected in [
            ('accept\n', 'accept'), ('decline\n', 'decline'), ('cancel\n', 'cancel'),
            ('\n', 'decline'), ('', 'decline'), ('yes\n', 'decline'),
            ('acceptForSession\n', 'decline'), ('allow-always\n', 'decline'),
        ]:
            with self.subTest(line=line):
                self.assertEqual(self.resolve(self.handler(line), command_request()), {'decision': expected})

    def test_shows_exact_scope_command_directory_and_reason_with_control_characters_quoted(self):
        output = io.StringIO()
        handler = self.handler(output=output)
        self.resolve(handler, command_request(command='echo 中文\n\x1b[2J', cwd=None, reason='line\nreason'))
        text = output.getvalue()
        self.assertIn('Thread: "thread-1"', text)
        self.assertIn('Turn: "turn-1"', text)
        self.assertIn('Command: "echo 中文\\n\\u001b[2J"', text)
        self.assertIn('Working directory: null', text)
        self.assertIn('Reason: "line\\nreason"', text)
        self.assertNotIn('\x1b', text)

    def test_session_choice_is_available_only_when_the_server_explicitly_offers_it(self):
        output = io.StringIO()
        handler = self.handler('acceptForSession\n', output=output, experimental=True)
        self.assertEqual(self.resolve(handler, command_request(
            availableDecisions=['accept', 'acceptForSession', 'decline', 'cancel'],
        )), {'decision': 'acceptForSession'})
        self.assertIn('acceptForSession', output.getvalue())
        self.assertEqual(self.resolve(self.handler('acceptForSession\n'), command_request(
            availableDecisions=['accept', 'decline', 'cancel'],
        )), {'decision': 'decline'})
        self.assertEqual(self.resolve(self.handler('acceptForSession\n'), command_request(
            availableDecisions=['accept', 'acceptForSession', 'decline', 'cancel'],
        )), {'decision': 'decline'})

    def test_unknown_or_other_scope_does_not_read_stdin(self):
        reads = []
        handler = self.handler(read_line=lambda: reads.append(True) or 'accept')
        self.assertIsNone(handler({'id': 3, 'method': 'unknown', 'params': {}}))
        for request in [
            command_request(threadId='other'), command_request(turnId='other'),
            command_request(threadId=''), {'method': COMMAND_APPROVAL, 'params': None},
        ]:
            self.assertEqual(handler(request), {'decision': 'decline'})
        other_plugin = plugin_request()
        other_plugin['params']['turnId'] = 'other'
        self.assertEqual(handler(other_plugin), {'answers': {}})
        self.assertEqual(reads, [])
        self.assertIsNone(handler._worker)

    def test_unsupported_command_shapes_are_denied(self):
        handler = self.handler()
        for fields in [
            {'kind': 'network'}, {'kind': 'stdin'}, {'command': None}, {'command': '  '},
            {'command': ['echo', 'hello']}, {'cwd': {}}, {'reason': []},
        ]:
            with self.subTest(fields=fields):
                self.assertEqual(handler(command_request(**fields)), {'decision': 'decline'})
        self.assertIsNone(handler._worker)

    def test_input_error_is_denied(self):
        def unavailable_input():
            raise OSError('stdin unavailable')

        self.assertEqual(self.resolve(self.handler(read_line=unavailable_input), command_request()),
                         {'decision': 'decline'})

    def test_worker_does_not_block_caller_and_late_cancelled_input_cannot_grant(self):
        entered, release = Event(), Event()

        def blocked_input():
            entered.set()
            release.wait(timeout=2)
            return 'accept'

        handler = self.handler(read_line=blocked_input)
        pending = handler(command_request())
        try:
            self.assertIsInstance(pending, Future)
            self.assertTrue(entered.wait(timeout=1))
            self.assertFalse(pending.done())
            self.assertTrue(handler._worker.daemon)
            pending.cancel()  # common does this on resolved, timeout, or turn completion.
            worker = handler._worker
            self.assertEqual(handler(command_request(itemId='new-tool')), {'decision': 'decline'})
            self.assertIs(handler._worker, worker)
        finally:
            release.set()
            handler.close()
        self.assertTrue(pending.cancelled())

    def test_close_cancels_pending_and_rejects_new_input(self):
        entered, release = Event(), Event()

        def blocked_input():
            entered.set()
            release.wait(timeout=2)
            return 'accept'

        handler = self.handler(read_line=blocked_input)
        pending = handler(command_request())
        try:
            self.assertTrue(entered.wait(timeout=1))
            handler.close()
            self.assertTrue(pending.cancelled())
            self.assertEqual(handler(command_request()), {'decision': 'decline'})
        finally:
            release.set()

    def test_scope_withdrawn_while_reading_cannot_grant(self):
        entered, release = Event(), Event()
        owned = [True]

        def blocked_input():
            entered.set()
            release.wait(timeout=2)
            return 'accept'

        handler = self.handler(owns_turn=lambda *_: owned[0], read_line=blocked_input)
        pending = handler(command_request())
        try:
            self.assertTrue(entered.wait(timeout=1))
            owned[0] = False
        finally:
            release.set()
        self.assertEqual(pending.result(timeout=1), {'decision': 'decline'})

    def test_plugin_requires_experimental_opt_in(self):
        handler = self.handler('1')
        self.assertEqual(handler(plugin_request()), {'answers': {}})
        self.assertIsNone(handler._worker)

    def test_plugin_returns_exact_advertised_label_in_any_language(self):
        for line, label in [('1', '仅允许一次'), ('2', '拒绝')]:
            with self.subTest(line=line):
                self.assertEqual(self.resolve(self.handler(line, experimental=True), plugin_request()),
                                 {'answers': {'permission': {'answers': [label]}}})

    def test_plugin_blank_freeform_and_cancel_are_denied(self):
        for line in ['', '\n', 'accept', 'cancel', '仅允许一次', '3', '1,2']:
            with self.subTest(line=line):
                self.assertEqual(self.resolve(self.handler(line, experimental=True), plugin_request()),
                                 {'answers': {}})

    def test_explicit_app_grant_choice_returns_only_the_advertised_label(self):
        request = plugin_request()
        request['params']['questions'][0]['options'].insert(1, {
            'label': '始终允许此App', 'description': '允许此App后续调用，无需逐次确认',
        })
        self.assertEqual(self.resolve(self.handler('2', experimental=True), request),
                         {'answers': {'permission': {'answers': ['始终允许此App']}}})

    def test_plugin_rejects_unadapted_question_shapes_without_prompting(self):
        handler = self.handler('1', experimental=True)
        changes = [
            lambda params: params.update(isBlocking=False),
            lambda params: params.update(questions=[]),
            lambda params: params['questions'].append(deepcopy(params['questions'][0])),
            lambda params: params['questions'][0].update(id='other'),
            lambda params: params['questions'][0].update(isOther=True),
            lambda params: params['questions'][0].update(isSecret=True),
            lambda params: params['questions'][0].update(options=None),
            lambda params: params['questions'][0]['options'].pop(),
            lambda params: params['questions'][0]['options'][0].update(label=''),
            lambda params: params['questions'][0]['options'][0].update(description=None),
            lambda params: params['questions'][0]['options'][1].update(label='仅允许一次'),
        ]
        for change in changes:
            request = plugin_request()
            change(request['params'])
            with self.subTest(request=request):
                self.assertEqual(handler(request), {'answers': {}})
        self.assertIsNone(handler._worker)


if __name__ == '__main__':
    unittest.main()
