"""Standard media example checks; no desktop process, credentials or network."""

from contextlib import nullcontext, redirect_stderr
from io import StringIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import media


class MediaTests(unittest.TestCase):
    def run_example(self, arguments):
        calls = []

        class Client:
            def call(self, method, params):
                calls.append((method, params))
                return {'thread': {'id': 'thread'}} if method != 'turn/start' else {'turn': {'id': 'turn'}}

            def wait_turns(self, pairs, **options):
                return {pairs[0]: SimpleNamespace(completed=True)}

        with (
            patch.object(media, 'open_client', return_value=nullcontext(Client())),
            patch.object(media, 'print_turn_result'),
            redirect_stderr(StringIO()),
        ):
            self.assertEqual(media.main(['--config', 'outside.json', *arguments]), 0)
        return calls

    def test_image_only_input_has_no_generated_text_and_preserves_media_order(self):
        calls = self.run_example([
            '--local-image', 'first.png', '--image-url', 'http://10.0.0.5/second.png',
            '--local-image', 'third.png', '--thread-id', 'thread',
        ])
        self.assertEqual(calls, [
            ('thread/resume', {'threadId': 'thread', 'excludeTurns': True}),
            ('turn/start', {'threadId': 'thread', 'input': [
                {'type': 'localImage', 'path': 'first.png'},
                {'type': 'image', 'url': 'http://10.0.0.5/second.png'},
                {'type': 'localImage', 'path': 'third.png'},
            ]}),
        ])

    def test_client_file_becomes_inline_bytes_and_does_not_expose_client_path(self):
        with TemporaryDirectory() as directory:
            file = Path(directory) / 'pixel.png'
            file.write_bytes(b'\x89PNG\r\n\x1a\nfixture')
            calls = self.run_example(['--image-file', str(file), '--message', 'Inspect', '--model', 'provider/image'])
        self.assertEqual(calls[0], ('thread/start', {'model': 'provider/image'}))
        params = calls[1][1]
        self.assertEqual(params['model'], 'provider/image')
        self.assertEqual(params['input'][0], {'type': 'text', 'text': 'Inspect'})
        self.assertTrue(params['input'][1]['url'].startswith('data:image/png;base64,'))
        self.assertNotIn(directory, repr(params))

    def test_invalid_media_is_rejected_before_connecting(self):
        for arguments in [[], ['--image-url', 'file:///private.png'],
                          ['--image-url', 'https://user:password@example.invalid/image.png'],
                          ['--local-image', 'one.png', '--message', ' ']]:
            with self.subTest(arguments=arguments), patch.object(media, 'open_client') as connect, redirect_stderr(StringIO()):
                with self.assertRaises(SystemExit):
                    media.main(['--config', 'outside.json', *arguments])
                connect.assert_not_called()

    def test_user_image_notifications_are_not_dumped_to_the_console(self):
        with patch.object(media, 'print_notification') as output:
            media._notification({'method': 'item/completed', 'params': {
                'item': {'type': 'userMessage', 'content': [{'type': 'image', 'url': 'data:private-bytes'}]},
            }})
            output.assert_not_called()


if __name__ == '__main__':
    unittest.main()
