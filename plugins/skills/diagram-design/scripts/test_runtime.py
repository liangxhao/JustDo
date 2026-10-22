"""Exercise packaged diagram helpers without downloaded browser binaries."""

import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest


SCRIPTS = Path(__file__).resolve().parent
HTML = '''<!doctype html><html><head><meta charset="utf-8">
<style>body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.node { fill: #eeeeee; } .label { fill: #111111; }</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"
role="img" aria-labelledby="flow-title flow-desc"><title id="flow-title">数据流程</title>
<desc id="flow-desc">Source to output</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"
markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs>
<rect class="node" x="10" y="10" width="220" height="100"/>
<text class="label" x="30" y="60">分析</text>
<path d="M110,60 L190,60" stroke="#111111" marker-end="url(#arrow)"/>
</svg></body></html>'''


def load_helper(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class DiagramRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='diagram-runtime-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / '数据 flow.html'
        self.source.write_text(HTML, encoding='utf-8')

    def run_helper(self, script, *args):
        return subprocess.run(
            [sys.executable, '-X', 'utf8', str(SCRIPTS / script), *map(str, args)],
            capture_output=True, text=True, encoding='utf-8', check=True,
        )

    def test_self_check_rejects_external_fonts_by_default(self):
        helper = load_helper('self_check')
        self.assertEqual(helper.verify(self.source), [])
        self.source.write_text(HTML.replace('</head>', '<link rel="stylesheet" '
            'href="https://fonts.googleapis.com/css2?family=Geist"></head>'), encoding='utf-8')
        self.assertTrue(any('offline' in error for error in helper.verify(self.source)))

    def test_shipped_examples_pass_offline_self_check(self):
        helper = load_helper('self_check')
        for source in sorted((SCRIPTS.parent / 'assets').glob('*.html')):
            if source.name in {'index.html', 'icons.html'}:
                continue
            with self.subTest(example=source.name):
                self.assertEqual(helper.verify(source), [])

    def test_svg_cli_keeps_css_and_namespaces_defs_without_webfonts(self):
        source = HTML.replace('</style>', '@font-face { font-family: remote; '
            'src: url(https://example.invalid/font.woff2); }</style>')
        self.source.write_text(source, encoding='utf-8')
        output = self.root / 'export.svg'
        self.run_helper('export_svg.py', self.source, output)
        svg = output.read_text(encoding='utf-8')
        import xml.etree.ElementTree as ET
        parsed = ET.fromstring(svg)
        self.assertEqual(parsed.attrib['viewBox'], '0 0 240 120')
        self.assertIn('分析', svg)
        self.assertIn('.node', svg)
        self.assertIn('url(#', svg)
        self.assertNotIn('id="arrow"', svg)
        self.assertNotIn('@font-face', svg)
        self.assertNotIn('https://', svg)
        self.assertNotIn('@import', svg)

    def test_svg_export_supports_chinese_names_with_distinct_stable_ids(self):
        import xml.etree.ElementTree as ET

        directory = self.root / '中文 工作区'
        directory.mkdir()
        root_ids = set()
        for name in ('中文图表', '成本 flow', '收入 flow'):
            with self.subTest(name=name):
                source = directory / f'{name}.html'
                source.write_text(HTML, encoding='utf-8')
                self.run_helper('export_svg.py', source)
                output = source.with_suffix('.svg')
                first_export = output.read_bytes()
                root_ids.add(ET.fromstring(first_export).attrib['id'])
                self.run_helper('export_svg.py', source)
                self.assertEqual(output.read_bytes(), first_export)
        self.assertEqual(len(root_ids), 3)

    def test_svg_font_loaders_are_rejected_before_publishing(self):
        styles = (
            '@import url("https://fonts.googleapis.com/css2?family=Geist");',
            '@font-face { font-family: remote; src: url("https://example.invalid/font.woff2"); }',
            r'@im\70ort url("https://example.invalid/font.css");',
            r'@supports (display: grid) { @f\6fnt-face { font-family: remote; src: url("https://example.invalid/font.woff2"); } }',
        )
        for index, style in enumerate(styles):
            with self.subTest(style=style):
                self.source.write_text(HTML.replace('<defs>', f'<style>{style}</style><defs>'), encoding='utf-8')
                output = self.root / f'blocked-{index}.svg'
                with self.assertRaises(subprocess.CalledProcessError) as failure:
                    self.run_helper('export_svg.py', self.source, output)
                self.assertEqual(failure.exception.returncode, 2)
                self.assertIn('font loader', failure.exception.stderr)
                self.assertFalse(output.exists())

    def test_svg_css_font_loader_words_inside_strings_remain_literal(self):
        self.source.write_text(HTML.replace('<defs>', '<style>.note::before { '
            'content: "@import and @font-face are examples"; }</style><defs>'), encoding='utf-8')
        output = self.root / 'literal.svg'
        self.run_helper('export_svg.py', self.source, output)
        self.assertIn('@import and @font-face are examples', output.read_text(encoding='utf-8'))

    def test_self_check_inspects_each_responsive_image_candidate(self):
        helper = load_helper('self_check')
        for element in (
            '<img srcset="images/local.png 1x, https://example.invalid/remote.png 2x">',
            '<source srcset="data:image/png;base64,AAAA 1x, //example.invalid/remote.png 2x">',
            '<link rel="preload" as="image" imagesrcset="images/local.png 1x, https://example.invalid/remote.png 2x">',
        ):
            with self.subTest(element=element):
                self.source.write_text(HTML.replace('</body>', element + '</body>'), encoding='utf-8')
                self.assertTrue(any('remote reference' in error for error in helper.verify(self.source)))

        self.source.write_text(HTML.replace('</body>', '<img srcset="data:image/png;base64,AAAA 1x, '
            'images/local.png 2x"></body>'), encoding='utf-8')
        self.assertEqual(helper.verify(self.source), [])

    def test_invalid_svg_does_not_publish_an_output(self):
        self.source.write_text(HTML.replace('240 120', '0 120'), encoding='utf-8')
        output = self.root / 'invalid.svg'
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_helper('export_svg.py', self.source, output)
        self.assertEqual(failure.exception.returncode, 2)
        self.assertFalse(output.exists())

    def test_drawio_mermaid_and_excalidraw_imports(self):
        fixtures = {
            'drawio_extract.py': ('source.drawio', '''<mxfile><diagram name="Page-1">
<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="A" value="Source" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="B" value="Output" vertex="1" parent="1"><mxGeometry x="150" y="0" width="80" height="40" as="geometry"/></mxCell>
<mxCell id="e" edge="1" source="A" target="B" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>'''),
            'mermaid_extract.py': ('source.mmd', 'flowchart LR\nA[Source] --> B[Output]\n'),
            'excalidraw_extract.py': ('source.excalidraw', json.dumps({
                'type': 'excalidraw', 'version': 2, 'elements': [
                    {'id': 'A', 'type': 'rectangle', 'x': 0, 'y': 0, 'width': 80, 'height': 40,
                     'boundElements': [{'id': 'label', 'type': 'text'}]},
                    {'id': 'label', 'type': 'text', 'x': 10, 'y': 10, 'width': 50, 'height': 20,
                     'text': 'Source', 'containerId': 'A'},
                    {'id': 'B', 'type': 'text', 'x': 150, 'y': 10, 'width': 50, 'height': 20,
                     'text': 'Output'},
                ],
            })),
        }
        for script, (name, content) in fixtures.items():
            with self.subTest(script=script):
                source = self.root / name
                source.write_text(content, encoding='utf-8')
                result = self.run_helper(script, source, '--json')
                data = json.loads(result.stdout)
                self.assertIn('Source', json.dumps(data))
                self.assertIn('Output', json.dumps(data))

    @unittest.skipUnless(os.name == 'nt' and importlib.util.find_spec('playwright'),
                         'requires Windows, Python Playwright, and installed Edge')
    def test_png_uses_installed_edge_and_blocks_http_requests(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            external = f'http://127.0.0.1:{server.server_port}/remote.png'
            self.source.write_text(HTML.replace('<body>', f'<body><img src="{external}">'), encoding='utf-8')
            output = self.root / 'export.png'
            self.run_helper('export_png.py', self.source, output)
            png = output.read_bytes()
            self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
            self.assertEqual(struct.unpack('>II', png[16:24]), (480, 240))
            self.assertEqual(hits, [])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
