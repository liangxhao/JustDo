#!/usr/bin/env python3
"""Observe an existing external thread without submitting or controlling its work."""

import argparse
import sys
import time

from app_server_client import open_client, positive_timeout, print_notification, run_cli


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Path to the WebSocket connection JSON copied from desktop settings')
    parser.add_argument('--thread-id', required=True, help='Existing external thread ID to observe')
    parser.add_argument('--timeout', type=positive_timeout, default=300.0, help='Observation duration in seconds (default: 300)')
    args = parser.parse_args(argv)
    if not args.thread_id.strip():
        parser.error('--thread-id must not be blank')
    return args


def notification_thread(message: dict):
    params = message.get('params')
    if not isinstance(params, dict):
        return None
    if isinstance(params.get('threadId'), str):
        return params['threadId']
    thread = params.get('thread')
    return thread.get('id') if isinstance(thread, dict) else None


def run(client, args) -> int:
    subscribed = False
    try:
        result = client.call('thread/resume', {'threadId': args.thread_id, 'excludeTurns': True})
        subscribed = True
        thread = result.get('thread')
        if not isinstance(thread, dict) or thread.get('id') != args.thread_id:
            raise ValueError('The resumed thread does not match the requested thread.')
        print(f'Observing thread {args.thread_id}; no turn will be submitted.', file=sys.stderr)
        deadline = time.monotonic() + args.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 0
            try:
                message = client.next_notification(remaining)
            except TimeoutError:
                return 0  # The requested observation window ended normally.
            if notification_thread(message) == args.thread_id:
                print_notification(message)
            # A foreign turn/completed is only an observed event. Continue
            # watching later turns until the observation deadline or Ctrl+C.
    finally:
        if subscribed and not client.is_closed:
            unwinding = sys.exc_info()[0] is not None
            try:
                client.call('thread/unsubscribe', {'threadId': args.thread_id}, timeout=5.0)
            except (Exception, KeyboardInterrupt) as error:
                if isinstance(error, KeyboardInterrupt) and not unwinding:
                    raise
                # Cleanup must not replace a transport error or Ctrl+C. Closing
                # this observer cannot cancel work owned by another connection.
                print('Unsubscribe was not confirmed; the observer connection is closing.', file=sys.stderr)


def main(argv=None) -> int:
    args = parse_args(argv)
    with open_client(args.config, client_name='python-subscribe-example') as client:
        return run(client, args)


if __name__ == '__main__':
    raise SystemExit(run_cli(main))
