#!/usr/bin/env python3
"""Send standard image/localImage input, with optional text, to app-server."""

import argparse
import base64
import mimetypes
from pathlib import Path
import sys
from urllib.parse import urlsplit

from app_server_client import open_client, positive_timeout, print_notification, print_turn_result, run_cli

MAX_IMAGE_BYTES = 4 * 1024 * 1024
IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}


class _MediaArgument(argparse.Action):
    def __call__(self, parser, namespace, value, option_string=None):
        media = list(getattr(namespace, 'media', None) or [])
        media.append((option_string, value))
        namespace.media = media


def _input(args, parser):
    content = []
    if args.message is not None:
        if not args.message.strip():
            parser.error('--message must contain text when supplied')
        content.append({'type': 'text', 'text': args.message})
    if not args.media or len(args.media) > 5:
        parser.error('provide one to five image arguments')
    total_bytes = 0
    for option, value in args.media:
        if option == '--image-file':
            file = Path(value)
            mime = mimetypes.guess_type(file.name)[0]
            if mime not in IMAGE_TYPES:
                parser.error('--image-file must be PNG, JPEG, GIF or WebP')
            with file.open('rb') as source:
                data = source.read(MAX_IMAGE_BYTES - total_bytes + 1)
            total_bytes += len(data)
            if not data or total_bytes > MAX_IMAGE_BYTES:
                parser.error('image files must be nonempty and total at most 4 MiB')
            encoded = base64.b64encode(data).decode('ascii')
            content.append({'type': 'image', 'url': f'data:{mime};base64,{encoded}'})
        elif option == '--local-image':
            if not value.strip():
                parser.error('--local-image requires a path on the desktop app machine')
            content.append({'type': 'localImage', 'path': value})
        else:
            url = urlsplit(value)
            if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
                parser.error('--image-url requires HTTP(S) without URL credentials')
            content.append({'type': 'image', 'url': value})
    return content


def _notification(event):
    # User items contain image bytes; keep the example's console focused on output.
    if event.get('params', {}).get('item', {}).get('type') != 'userMessage':
        print_notification(event)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, help='Path to the WebSocket connection JSON copied from desktop settings')
    parser.add_argument('--message', help='Optional text; omit for image-only input')
    parser.add_argument('--image-file', action=_MediaArgument, help='Read an image on this client and send its bytes')
    parser.add_argument('--local-image', action=_MediaArgument, help='Image path inside the desktop thread working directory')
    parser.add_argument('--image-url', action=_MediaArgument, help='Image at a permitted private-network literal HTTP(S) address')
    parser.add_argument('--thread-id', help='Explicit external thread to resume without replaying old input')
    parser.add_argument('--cwd', help='Absolute working directory on the desktop app machine')
    parser.add_argument('--model', help='Exact configured model ID; image support depends on the model')
    parser.add_argument('--timeout', type=positive_timeout, default=300)
    parser.set_defaults(media=None)
    args = parser.parse_args(argv)
    if args.thread_id is not None and not args.thread_id.strip():
        parser.error('--thread-id must contain an external thread ID')
    if args.model is not None and not args.model.strip():
        parser.error('--model must contain a model ID')
    content = _input(args, parser)
    with open_client(args.config, client_name='python-media-example') as client:
        options = {'cwd': args.cwd} if args.cwd is not None else {}
        method = 'thread/start'
        if args.thread_id is not None:
            method = 'thread/resume'
            options.update(threadId=args.thread_id, excludeTurns=True)
        thread_id = client.call(method, options)['thread']['id']
        params = {'threadId': thread_id, 'input': content}
        if args.model is not None:
            params['model'] = args.model
        turn_id = client.call('turn/start', params)['turn']['id']
        print(f'Thread ID: {thread_id}\nTurn ID: {turn_id}', file=sys.stderr, flush=True)
        pair = (thread_id, turn_id)
        result = client.wait_turns([pair], timeout=args.timeout, on_event=_notification)[pair]
        print_turn_result(result)
        return 0 if result.completed else 1


if __name__ == '__main__':
    raise SystemExit(run_cli(main))
