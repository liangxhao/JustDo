#!/usr/bin/env python3
"""Read external-thread metadata or authenticated history without starting a turn."""

import argparse

from app_server_client import open_client, print_notification, run_cli


def page_limit(value: str) -> int:
    limit = int(value)
    if not 1 <= limit <= 200:
        raise argparse.ArgumentTypeError('Use a page limit between 1 and 200.')
    return limit


def page_count(value: str) -> int:
    count = int(value)
    if count < 1:
        raise argparse.ArgumentTypeError('Use at least one page.')
    return count


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Copied WebSocket connection JSON saved outside the repository')
    parser.add_argument('--thread-id', help='External thread ID; omit to list thread metadata')
    parser.add_argument('--view', choices=('turns', 'items', 'full'), default='turns', help='History view for --thread-id (default: turns)')
    parser.add_argument('--limit', type=page_limit, default=50, help='Entries per page, 1 to 200 (default: 50)')
    parser.add_argument('--pages', type=page_count, default=1, help='Maximum pages to read (default: 1)')
    parser.add_argument('--cursor', help='Exact nextCursor from an earlier page of the same query')
    parser.add_argument('--turn-id', help='Limit --view items to this exact turn')
    args = parser.parse_args(argv)
    if args.thread_id is not None and not args.thread_id.strip():
        parser.error('--thread-id must not be blank')
    if args.turn_id is not None and (not args.turn_id.strip() or not args.thread_id or args.view != 'items'):
        parser.error('--turn-id requires --thread-id and --view items')
    if not args.thread_id and args.view != 'turns':
        parser.error('--view items/full requires --thread-id')
    if args.view == 'full' and args.cursor is not None:
        parser.error('--cursor applies to paginated views, not --view full')
    return args


def run(client, args) -> int:
    if args.thread_id and args.view == 'full':
        # Full reads do not resume, subscribe, or acquire execution ownership.
        result = client.call('thread/read', {'threadId': args.thread_id, 'includeTurns': True})
        print_notification({'method': 'thread/read', 'result': result})
        return 0

    params = {'limit': args.limit}
    if not args.thread_id:
        method = 'thread/list'
    elif args.view == 'items':
        method = 'thread/items/list'
        params['threadId'] = args.thread_id
        if args.turn_id is not None:
            params['turnId'] = args.turn_id
    else:
        method = 'thread/turns/list'
        params.update({'threadId': args.thread_id, 'itemsView': 'summary'})

    cursor = args.cursor
    seen = set()
    if cursor is not None:
        seen.add(cursor)
    for page in range(1, args.pages + 1):
        query = {**params, **({'cursor': cursor} if cursor is not None else {})}
        # An invalidated cursor is an error. Never restart the query automatically.
        result = client.call(method, query)
        following = result.get('nextCursor')
        if following is not None and (not isinstance(following, str) or not following or following in seen):
            raise ValueError('The server returned an invalid or repeated pagination cursor.')
        print_notification({'method': method, 'page': page, 'result': result})
        if following is None:
            break
        seen.add(following)
        cursor = following
    # Each printed page retains nextCursor, including when --pages stops early.
    # Results go only to stdout; this example does not write transcript files.
    return 0


def main(argv=None) -> int:
    args = parse_args(argv)
    with open_client(args.config, client_name='python-history-example') as client:
        return run(client, args)


if __name__ == '__main__':
    raise SystemExit(run_cli(main))
