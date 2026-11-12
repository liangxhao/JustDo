"""Behavior checks for concurrent task admission and draining; no live app required."""

from contextlib import contextmanager, nullcontext, redirect_stderr
from io import StringIO
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parallel_turns


class RejectedTask(Exception):
    pass


class WaitExpired(TimeoutError):
    def __init__(self, partial_results):
        super().__init__('Some execution outcomes remain unknown.')
        self.partial_results = partial_results
        self.pending = {('thread-2', 'turn-2')}


class ParallelTurnsTests(unittest.TestCase):
    def test_admits_all_tasks_before_waiting_and_drains_even_when_one_turn_fails(self):
        calls = []
        results = {
            ('thread-2', 'turn-2'): SimpleNamespace(completed=False, outcome_unknown=True),
            ('thread-3', 'turn-3'): SimpleNamespace(completed=True),
            ('thread-1', 'turn-1'): SimpleNamespace(completed=True),
        }

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                number = (len(calls) + 1) // 2
                return {'thread': {'id': f'thread-{number}'}} if method == 'thread/start' else {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, pairs, **options):
                self.waited = (list(pairs), options)
                self.calls_when_waiting = len(calls)
                return results

        client = Client()
        with (
            patch.object(parallel_turns, 'open_client', return_value=nullcontext(client)) as connect,
            patch.object(parallel_turns, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            code = parallel_turns.main([
                '--config', 'copied-config.json', '--message', 'One', '--message', 'Two', '--message', 'Three',
                '--model', 'model/one', '--model', 'model/two', '--model', 'model/three', '--timeout', '75',
            ])

        self.assertEqual(code, 1)
        connect.assert_called_once_with('copied-config.json', client_name='python-parallel-turns-example')
        self.assertEqual(client.calls_when_waiting, 6)
        self.assertEqual(client.waited[0], [('thread-1', 'turn-1'), ('thread-2', 'turn-2'), ('thread-3', 'turn-3')])
        self.assertEqual(client.waited[1]['timeout'], 75)
        self.assertEqual([params['model'] for method, params in calls if method == 'thread/start'], ['model/one', 'model/two', 'model/three'])
        self.assertEqual([params['model'] for method, params in calls if method == 'turn/start'], ['model/one', 'model/two', 'model/three'])
        self.assertEqual([call.args[0] for call in output.call_args_list], [results[pair] for pair in client.waited[0]])

    def test_rpc_rejection_does_not_cancel_other_admissions_or_retry_the_rejected_task(self):
        calls = []
        waited = []

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                number = (len(calls) + 1) // 2
                if method == 'thread/start':
                    return {'thread': {'id': f'thread-{number}'}}
                if number == 2:
                    raise RejectedTask('Explicit RPC rejection')
                return {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, pairs, **_options):
                waited.extend(pairs)
                return {pair: SimpleNamespace(completed=True) for pair in pairs}

        with (
            patch.object(parallel_turns, 'open_client', return_value=nullcontext(Client())),
            patch.object(parallel_turns, 'RpcError', RejectedTask),
            patch.object(parallel_turns, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            code = parallel_turns.main([
                '--config', 'copied-config.json', '--message', 'One', '--message', 'Rejected', '--message', 'Three',
            ])

        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 6)
        self.assertEqual(waited, [('thread-1', 'turn-1'), ('thread-3', 'turn-3')])
        self.assertEqual(output.call_count, 2)

    def test_uncertain_admission_still_drains_previously_known_turns_without_starting_later_tasks(self):
        calls = []
        waited = []

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                if len(calls) == 4:
                    raise TimeoutError('Admission response was not observed.')
                number = (len(calls) + 1) // 2
                return {'thread': {'id': f'thread-{number}'}} if method == 'thread/start' else {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, pairs, **_options):
                waited.extend(pairs)
                return {pair: SimpleNamespace(completed=True) for pair in pairs}

        with (
            patch.object(parallel_turns, 'open_client', return_value=nullcontext(Client())),
            patch.object(parallel_turns, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            with self.assertRaises(TimeoutError):
                parallel_turns.main([
                    '--config', 'copied-config.json', '--message', 'Known', '--message', 'Uncertain', '--message', 'Never sent',
                ])

        self.assertEqual(len(calls), 4)
        self.assertEqual(waited, [('thread-1', 'turn-1')])
        output.assert_called_once()

    def test_wait_timeout_preserves_partial_results_and_unknown_pending_outcomes_for_the_cli_handler(self):
        partial = {('thread-1', 'turn-1'): SimpleNamespace(completed=True)}
        failure = WaitExpired(partial)

        class Client:
            calls = 0

            def call(self, method, _params):
                self.calls += 1
                number = (self.calls + 1) // 2
                return {'thread': {'id': f'thread-{number}'}} if method == 'thread/start' else {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, _pairs, **_options):
                raise failure

        with (
            patch.object(parallel_turns, 'open_client', return_value=nullcontext(Client())),
            patch.object(parallel_turns, 'print_turn_result') as output,
            redirect_stderr(StringIO()),
        ):
            with self.assertRaises(WaitExpired) as caught:
                parallel_turns.main(['--config', 'copied-config.json', '--message', 'Settled', '--message', 'Pending'])
        self.assertIs(caught.exception, failure)
        self.assertEqual(caught.exception.pending, {('thread-2', 'turn-2')})
        self.assertEqual(caught.exception.partial_results, partial)
        output.assert_not_called()

    def test_keyboard_interrupt_closes_immediately_without_an_additional_turn_wait(self):
        closed = []

        class Client:
            calls = 0

            def call(self, method, _params):
                self.calls += 1
                if self.calls == 4:
                    raise KeyboardInterrupt()
                number = (self.calls + 1) // 2
                return {'thread': {'id': f'thread-{number}'}} if method == 'thread/start' else {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, _pairs, **_options):
                raise AssertionError('Ctrl+C must not start a long turn wait.')

        @contextmanager
        def connection():
            try:
                yield Client()
            finally:
                closed.append(True)

        with (
            patch.object(parallel_turns, 'open_client', return_value=connection()),
            redirect_stderr(StringIO()),
        ):
            with self.assertRaises(KeyboardInterrupt):
                parallel_turns.main(['--config', 'copied-config.json', '--message', 'Known', '--message', 'Interrupted'])
        self.assertEqual(closed, [True])

    def test_failed_drain_preserves_the_original_uncertain_submission_and_prints_partial_results_once(self):
        partial = {('thread-1', 'turn-1'): SimpleNamespace(completed=True)}
        original = TimeoutError('The third admission response was not observed; do not resend.')
        wait_failure = parallel_turns.TurnWaitTimeout({('thread-2', 'turn-2')}, partial)

        class Client:
            calls = 0

            def call(self, method, _params):
                self.calls += 1
                if self.calls == 6:
                    raise original
                number = (self.calls + 1) // 2
                return {'thread': {'id': f'thread-{number}'}} if method == 'thread/start' else {'turn': {'id': f'turn-{number}'}}

            def wait_turns(self, _pairs, **_options):
                raise wait_failure

        with (
            patch.object(parallel_turns, 'open_client', return_value=nullcontext(Client())),
            patch.object(parallel_turns, 'print_turn_result') as output,
            patch.object(parallel_turns, 'print_notification') as notifications,
            redirect_stderr(StringIO()),
        ):
            with self.assertRaises(TimeoutError) as caught:
                parallel_turns.main([
                    '--config', 'copied-config.json', '--message', 'Settled', '--message', 'Pending', '--message', 'Uncertain',
                ])

        self.assertIs(caught.exception, original)
        output.assert_called_once_with(partial[('thread-1', 'turn-1')])
        notifications.assert_called_once_with({'unfinishedTurns': [{'threadId': 'thread-2', 'turnId': 'turn-2'}]})

    def test_excess_thread_count_is_rejected_before_connecting(self):
        with patch.object(parallel_turns, 'open_client') as connect, redirect_stderr(StringIO()):
            with self.assertRaises(SystemExit) as failure:
                parallel_turns.main(['--config', 'copied-config.json'] + ['--message', 'Task'] * 33)
        self.assertEqual(failure.exception.code, 2)
        connect.assert_not_called()


if __name__ == '__main__':
    unittest.main()
