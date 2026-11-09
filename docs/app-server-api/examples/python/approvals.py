#!/usr/bin/env python3
"""Stream a turn while explicitly answering the server's supported approvals."""

import argparse
from concurrent.futures import Future, InvalidStateError
from dataclasses import dataclass
import json
from queue import Queue
import sys
from threading import Lock, Thread
from typing import Callable, TextIO


COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
TOOL_INPUT = 'item/tool/requestUserInput'


@dataclass
class _Prompt:
    future: Future
    text: str
    parse: Callable[[str], dict]
    denied: dict


class InteractiveApprovals:
    """One stdin worker; only the client's main pump may send its results."""

    def __init__(
        self,
        owns_turn: Callable[[str, str], bool],
        *,
        experimental: bool = False,
        read_line: Callable[[], str] | None = None,
        output: TextIO | None = None,
    ):
        self._owns_turn = owns_turn
        self._experimental = experimental
        self._read_line = read_line or sys.stdin.readline
        self._output = output if output is not None else sys.stderr
        self._queue: Queue = Queue(maxsize=1)
        self._lock = Lock()
        self._worker: Thread | None = None
        self._pending: Future | None = None
        self._busy = False
        self._closed = False

    def __call__(self, request: dict) -> dict | Future | None:
        method = request.get('method')
        if method not in (COMMAND_APPROVAL, TOOL_INPUT):
            return None  # The common client replies with Method not found.
        denied = {'decision': 'decline'} if method == COMMAND_APPROVAL else {'answers': {}}
        params = request.get('params')
        if not isinstance(params, dict):
            return denied
        thread_id, turn_id = params.get('threadId'), params.get('turnId')
        if (
            not isinstance(thread_id, str) or not thread_id
            or not isinstance(turn_id, str) or not turn_id
            or not self._owns_turn(thread_id, turn_id)
        ):
            return denied

        # Quote server-controlled fields so terminal control characters stay visible.
        scope = f'Thread: {self._quoted(thread_id)}\nTurn: {self._quoted(turn_id)}'
        if method == COMMAND_APPROVAL:
            command = params.get('command')
            if (
                params.get('kind', 'command') != 'command'
                or not isinstance(command, str) or not command.strip()
                or not self._optional_text(params.get('cwd'))
                or not self._optional_text(params.get('reason'))
            ):
                return denied
            allow_session = (
                self._experimental
                and isinstance(params.get('availableDecisions'), list)
                and 'acceptForSession' in params['availableDecisions']
            )
            choices = 'accept, acceptForSession, decline, or cancel' if allow_session else 'accept, decline, or cancel'
            prompt = (
                f'\nCommand approval (choose an explicit scope)\n{scope}\n'
                f'Command: {self._quoted(command)}\n'
                f'Working directory: {self._quoted(params.get("cwd"))}\n'
                f'Reason: {self._quoted(params.get("reason"))}\n'
                'accept allows only this request; cancel denies and requests stopping this turn.\n'
                + ('acceptForSession reuses the same command/environment in this connection and session; '
                   'it does not create a permanent rule.\n' if allow_session else '')
                + f'Type {choices}; Enter declines: '
            )

            def parse_command(line: str) -> dict:
                if not self._owns_turn(thread_id, turn_id):
                    return denied
                decision = line.strip().lower()
                if decision == 'acceptforsession' and allow_session:
                    return {'decision': 'acceptForSession'}
                return {'decision': decision if decision in ('accept', 'cancel') else 'decline'}

            return self._prompt(prompt, parse_command, denied)

        # This app's experimental plugin confirmation has one exact permission question.
        questions = params.get('questions')
        if not self._experimental or params.get('isBlocking') is not True:
            return denied
        if not isinstance(questions, list) or len(questions) != 1:
            return denied
        question = questions[0]
        if not isinstance(question, dict) or (
            question.get('id') != 'permission'
            or question.get('isOther') is not False
            or question.get('isSecret') is not False
            or not isinstance(question.get('header'), str)
            or not isinstance(question.get('question'), str)
        ):
            return denied
        options = question.get('options')
        if not isinstance(options, list) or len(options) not in (2, 3) or not all(
            isinstance(option, dict)
            and isinstance(option.get('label'), str) and option['label'].strip()
            and isinstance(option.get('description'), str)
            for option in options
        ):
            return denied
        labels = [option['label'] for option in options]
        if len(set(labels)) != len(labels):
            return denied
        prompt = (
            f'\nExperimental plugin permission (choose an explicitly offered scope)\n{scope}\n'
            f'{self._quoted(question["header"])}\n{self._quoted(question["question"])}\n'
            + ''.join(
                f'{index}. {self._quoted(option["label"])} — {self._quoted(option["description"])}\n'
                for index, option in enumerate(options, 1)
            )
            + f'Choose 1 through {len(options)}; Enter denies without selecting an option: '
        )

        def parse_plugin(line: str) -> dict:
            if not self._owns_turn(thread_id, turn_id):
                return denied
            choice = line.strip()
            if choice not in tuple(str(index) for index in range(1, len(labels) + 1)):
                return denied
            # Return the advertised label verbatim, regardless of the UI language.
            return {'answers': {'permission': {'answers': [labels[int(choice) - 1]]}}}

        return self._prompt(prompt, parse_plugin, denied)

    @staticmethod
    def _quoted(value: object) -> str:
        return json.dumps(value, ensure_ascii=False)

    @staticmethod
    def _optional_text(value: object) -> bool:
        return value is None or isinstance(value, str)

    def _prompt(self, text: str, parse: Callable[[str], dict], denied: dict) -> dict | Future:
        with self._lock:
            if self._closed:
                return denied
            if self._busy:
                print('\nPrevious stdin prompt is still waiting; this new request is denied.',
                      file=self._output, flush=True)
                return denied
            future: Future = Future()
            self._pending = future
            self._busy = True
            if self._worker is None:
                self._worker = Thread(target=self._read_prompts, name='approval-stdin', daemon=True)
                self._worker.start()
            self._queue.put_nowait(_Prompt(future, text, parse, denied))
            return future

    def _read_prompts(self) -> None:
        while True:
            prompt = self._queue.get()
            if prompt is None:
                return
            try:
                if not prompt.future.done():
                    print(prompt.text, end='', file=self._output, flush=True)
                    try:
                        result = prompt.parse(self._read_line())
                    except Exception:
                        result = prompt.denied
                    # resolved/timeout/close may cancel the Future during readline().
                    try:
                        prompt.future.set_result(result)
                    except InvalidStateError:
                        pass
            finally:
                with self._lock:
                    self._busy = False
                    self._pending = None
                    if self._closed:
                        return

    def close(self) -> None:
        # stdin cannot be interrupted portably. A blocked daemon must never send later.
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._pending is not None:
                self._pending.cancel()
            if self._worker is not None and not self._busy:
                self._queue.put_nowait(None)


def main() -> int:
    from app_server_client import (
        open_client, positive_timeout, print_notification, print_turn_result,
    )

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Path to the WebSocket connection JSON copied from desktop settings')
    parser.add_argument('--message', required=True, help='Text for the assistant; tools may require approval')
    parser.add_argument('--model', help='Model ID returned by model/list')
    parser.add_argument('--cwd', help='Absolute working directory on the desktop machine')
    parser.add_argument('--thread-id', help='External thread to resume without replaying history')
    parser.add_argument('--timeout', type=positive_timeout, default=300, help='Whole-turn wait in seconds')
    parser.add_argument('--experimental', action='store_true', help='Opt into experimental plugin confirmations')
    args = parser.parse_args()
    if not args.message.strip():
        parser.error('--message must not be empty')

    holder = {}
    approvals = InteractiveApprovals(
        lambda thread_id, turn_id: 'client' in holder and holder['client'].owns_turn(thread_id, turn_id),
        experimental=args.experimental,
    )
    try:
        with open_client(
            args.config, client_name='python-interactive-approvals', experimental=args.experimental,
            request_handler=approvals,
        ) as client:
            holder['client'] = client
            options = {}
            if args.model is not None:
                options['model'] = args.model
            if args.cwd is not None:
                options['cwd'] = args.cwd
            method = 'thread/start'
            if args.thread_id is not None:
                method = 'thread/resume'
                options.update(threadId=args.thread_id, excludeTurns=True)
            thread_id = client.call(method, options)['thread']['id']
            turn_id = client.call('turn/start', {
                'threadId': thread_id, 'input': [{'type': 'text', 'text': args.message}],
            })['turn']['id']
            print(f'Thread ID: {thread_id}\nTurn ID: {turn_id}', file=sys.stderr, flush=True)
            result = client.wait_turns(
                {(thread_id, turn_id)}, timeout=args.timeout, on_event=print_notification,
            )[(thread_id, turn_id)]
            print_turn_result(result)
            return 0 if result.completed else 1
    finally:
        approvals.close()


if __name__ == '__main__':
    from app_server_client import run_cli

    raise SystemExit(run_cli(main))
