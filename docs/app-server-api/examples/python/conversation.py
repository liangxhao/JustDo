#!/usr/bin/env python3
"""Send several explicit new messages to one app-server thread, in order."""

import argparse
import sys

from app_server_client import (
    open_client,
    positive_timeout,
    print_notification,
    print_turn_result,
    run_cli,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Path to the WebSocket connection JSON copied from desktop settings')
    parser.add_argument('--message', action='append', required=True, help='New message; repeat for each conversation turn')
    parser.add_argument('--model', action='append', default=[], help='One model for all turns, or repeat once per message')
    parser.add_argument('--thread-id', help='Explicit external thread ID to resume; existing inputs are never replayed')
    parser.add_argument('--cwd', help='Absolute working directory on the desktop app machine')
    parser.add_argument('--timeout', type=positive_timeout, default=300, help='Wait limit per turn, in seconds (default: 300)')
    args = parser.parse_args(argv)
    if any(not message.strip() for message in args.message):
        parser.error('--message must contain text')
    if any(not model.strip() for model in args.model):
        parser.error('--model must contain a model ID')
    if len(args.model) not in (0, 1, len(args.message)):
        parser.error('provide one --model for all messages, or one per --message')
    if args.thread_id is not None and not args.thread_id.strip():
        parser.error('--thread-id must contain an external thread ID')
    models = args.model * len(args.message) if len(args.model) == 1 else args.model

    with open_client(args.config, client_name='python-conversation-example') as client:
        options = {'cwd': args.cwd} if args.cwd is not None else {}
        method = 'thread/start'
        if args.thread_id is not None:
            method = 'thread/resume'
            # Resume observation and ownership without treating old inputs as new work.
            options.update(threadId=args.thread_id, excludeTurns=True)
        thread_id = client.call(method, options)['thread']['id']
        print(f'Thread ID: {thread_id}', file=sys.stderr, flush=True)

        for index, message in enumerate(args.message):
            params = {'threadId': thread_id, 'input': [{'type': 'text', 'text': message}]}
            if models:
                params['model'] = models[index]
            turn_id = client.call('turn/start', params)['turn']['id']
            print(f'Turn {index + 1} ID: {turn_id}', file=sys.stderr, flush=True)
            pair = (thread_id, turn_id)
            result = client.wait_turns([pair], timeout=args.timeout, on_event=print_notification)[pair]
            print_turn_result(result)
            # Failed, interrupted and unknown turns stop this sequence. None is
            # permission to replay the message or continue from an uncertain state.
            if not result.completed:
                return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(run_cli(main))
