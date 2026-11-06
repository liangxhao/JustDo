#!/usr/bin/env python3
"""Run independent app-server threads concurrently over one WebSocket connection."""

import argparse
import sys

from app_server_client import (
    open_client,
    positive_timeout,
    print_notification,
    print_turn_result,
    RpcError,
    run_cli,
    TurnWaitTimeout,
)


MAX_THREADS = 32


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Connection JSON copied to a file outside the repository')
    parser.add_argument('--message', action='append', required=True, help='Independent task; repeat for each new thread')
    parser.add_argument('--model', action='append', default=[], help='One model for all tasks, or repeat once per message')
    parser.add_argument('--cwd', help='Shared absolute working directory on the desktop app machine')
    parser.add_argument('--timeout', type=positive_timeout, default=300, help='Total wait limit after admissions, in seconds (default: 300)')
    args = parser.parse_args(argv)
    if len(args.message) > MAX_THREADS:
        parser.error(f'a connection can load at most {MAX_THREADS} threads')
    if any(not message.strip() for message in args.message):
        parser.error('--message must contain text')
    if any(not model.strip() for model in args.model):
        parser.error('--model must contain a model ID')
    if len(args.model) not in (0, 1, len(args.message)):
        parser.error('provide one --model for all tasks, or one per --message')
    models = args.model * len(args.message) if len(args.model) == 1 else args.model

    with open_client(args.config, client_name='python-parallel-turns-example') as client:
        pairs = []
        rejected = False
        results = {}
        admission_failure = None
        try:
            for index, message in enumerate(args.message):
                try:
                    options = {'cwd': args.cwd} if args.cwd is not None else {}
                    thread_id = client.call('thread/start', options)['thread']['id']
                    print(f'Task {index + 1} thread ID: {thread_id}', file=sys.stderr, flush=True)
                    params = {'threadId': thread_id, 'input': [{'type': 'text', 'text': message}]}
                    if models:
                        params['model'] = models[index]
                    turn_id = client.call('turn/start', params)['turn']['id']
                    pairs.append((thread_id, turn_id))
                    print(f'Task {index + 1} turn ID: {turn_id}', file=sys.stderr, flush=True)
                except RpcError as error:
                    # A rejected task does not cancel independent admitted work.
                    # It is not retried; later entries are distinct explicit tasks.
                    rejected = True
                    print(f'Task {index + 1} admission rejected: {error}', file=sys.stderr, flush=True)
        except Exception as error:
            admission_failure = error
        # KeyboardInterrupt bypasses the Exception handler and immediately closes
        # this connection. Never turn Ctrl+C into another long wait.
        if pairs:
            try:
                # Calls may receive another thread's completion during admission.
                # The shared single-reader pump retains those notifications.
                # run_cli reports any timeout's partial results and unfinished IDs
                # once; this layer must not turn pending work into a failed result.
                results = client.wait_turns(pairs, timeout=args.timeout, on_event=print_notification)
            except Exception as drain_error:
                if admission_failure is None:
                    raise
                # Preserve the first uncertain submission when further observation
                # also fails; neither failure authorizes resending that input.
                pending = pairs
                if isinstance(drain_error, TurnWaitTimeout):
                    for result in drain_error.partial_results.values():
                        print_turn_result(result)
                    pending = drain_error.pending
                print_notification({'unfinishedTurns': [dict(threadId=thread, turnId=turn)
                    for thread, turn in sorted(pending)]})
                print('Previously admitted work could not be fully observed; unfinished outcomes remain unknown.',
                    file=sys.stderr, flush=True)
                raise admission_failure from None
            for pair in pairs:
                print_turn_result(results[pair])
        if admission_failure is not None:
            raise admission_failure
        return 0 if not rejected and all(result.completed for result in results.values()) else 1


if __name__ == '__main__':
    raise SystemExit(run_cli(main))
