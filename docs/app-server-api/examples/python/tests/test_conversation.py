"""Behavior checks for the sequential conversation example; no live app required."""

from contextlib import nullcontext, redirect_stderr
from io import StringIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import conversation


class ConversationTests(unittest.TestCase):
    def test_resume_sends_only_explicit_new_messages_with_per_turn_models(self):
        calls = []
        waits = []

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                if method == 'thread/resume':
                    return {'thread': {'id': 'resumed-thread'}}
                return {'turn': {'id': f'turn-{len(waits) + 1}'}}

            def wait_turns(self, pairs, **options):
                waits.append((pairs, options))
                return {pairs[0]: SimpleNamespace(completed=True)}

        with (
            patch.object(conversation, 'open_client', return_value=nullcontext(Client())) as connect,
            patch.object(conversation, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            code = conversation.main([
                '--config', 'copied-config.json', '--thread-id', 'resumed-thread',
                '--message', 'First new input', '--message', 'Second new input',
                '--model', 'provider/first', '--model', 'provider/second', '--timeout', '42',
            ])

        self.assertEqual(code, 0)
        connect.assert_called_once_with('copied-config.json', client_name='python-conversation-example')
        self.assertEqual(calls, [
            ('thread/resume', {'threadId': 'resumed-thread', 'excludeTurns': True}),
            ('turn/start', {'threadId': 'resumed-thread', 'input': [{'type': 'text', 'text': 'First new input'}], 'model': 'provider/first'}),
            ('turn/start', {'threadId': 'resumed-thread', 'input': [{'type': 'text', 'text': 'Second new input'}], 'model': 'provider/second'}),
        ])
        self.assertEqual([entry[0] for entry in waits], [
            [('resumed-thread', 'turn-1')], [('resumed-thread', 'turn-2')],
        ])
        self.assertTrue(all(options['timeout'] == 42 for _, options in waits))
        self.assertEqual(output.call_count, 2)

    def test_unknown_outcome_stops_the_sequence_without_replay(self):
        calls = []
        unknown = SimpleNamespace(completed=False, outcome_unknown=True)

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                return {'thread': {'id': 'new-thread'}} if method == 'thread/start' else {'turn': {'id': 'uncertain-turn'}}

            def wait_turns(self, pairs, **_options):
                return {pairs[0]: unknown}

        with (
            patch.object(conversation, 'open_client', return_value=nullcontext(Client())),
            patch.object(conversation, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            code = conversation.main([
                '--config', 'copied-config.json', '--message', 'Submit once',
                '--message', 'Do not send after an unknown result', '--model', 'provider/shared',
            ])

        self.assertEqual(code, 1)
        self.assertEqual([method for method, _ in calls], ['thread/start', 'turn/start'])
        self.assertEqual(calls[1][1]['model'], 'provider/shared')
        output.assert_called_once_with(unknown)

    def test_invalid_model_count_is_rejected_before_connecting(self):
        with patch.object(conversation, 'open_client') as connect, redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as failure:
                conversation.main([
                    '--config', 'copied-config.json', '--message', 'One', '--message', 'Two',
                    '--model', 'a', '--model', 'b', '--model', 'c',
                ])
        self.assertEqual(failure.exception.code, 2)
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
