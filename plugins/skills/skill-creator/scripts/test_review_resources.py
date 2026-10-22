"""Exercise the restored review helpers on the bundled Python runtime."""

import importlib.util
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PageResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.remote = []
        self.scripts = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script':
            self.scripts += 1
        for key in ('src', 'href'):
            value = attrs.get(key, '')
            if value.startswith(('http:', 'https:', '//')):
                self.remote.append(value)


class ReviewResourceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='skill-review-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / '中文 工作区'
        self.root.mkdir()

    def run_helper(self, relative, *args, check=True):
        return subprocess.run(
            [sys.executable, '-X', 'utf8=0', str(ROOT / relative), *map(str, args)],
            capture_output=True, encoding='utf-8', errors='replace', check=check,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'),
        )

    def fixture(self, with_timing=True):
        iteration = self.root / 'iteration-1'
        case = iteration / 'eval-0-中文'
        case.mkdir(parents=True)
        (case / 'eval_metadata.json').write_text(json.dumps({
            'eval_id': 0, 'prompt': '处理中文输入 </script><script>window.injected=true</script>',
        }, ensure_ascii=False), encoding='utf-8')
        for config, passed, tokens in [('with_skill', True, 20), ('without_skill', False, 30)]:
            run = case / config / 'run-1'
            outputs = run / 'outputs'
            outputs.mkdir(parents=True)
            (outputs / '结果.txt').write_text('实际输出 中文', encoding='utf-8')
            (run / 'grading.json').write_text(json.dumps({
                'summary': {'pass_rate': int(passed), 'passed': int(passed), 'failed': int(not passed), 'total': 1},
                'expectations': [{'text': '输出中文', 'passed': passed, 'evidence': '结果.txt'}],
                'execution_metrics': {'output_chars': 999999},
            }, ensure_ascii=False), encoding='utf-8')
            if with_timing:
                (run / 'timing.json').write_text(json.dumps({
                    'total_duration_seconds': 1.5, 'total_tokens': tokens,
                }), encoding='utf-8')
        return iteration

    def test_static_reviewer_preserves_utf8_and_contains_untrusted_script_text(self):
        iteration = self.fixture()
        output = self.root / '审阅 页面.html'
        self.run_helper('eval-viewer/generate_review.py', iteration, '--skill-name', '中文技能', '--static', output)
        page = output.read_text(encoding='utf-8')
        resources = PageResources()
        resources.feed(page)
        self.assertEqual(resources.remote, [])
        self.assertEqual(resources.scripts, 1)
        data = re.search(r'const EMBEDDED_DATA = (.*?);\n', page).group(1)
        embedded = json.loads(data)
        self.assertEqual(embedded['skill_name'], '中文技能')
        self.assertEqual(len(embedded['runs']), 2)
        self.assertIn('</script><script>', embedded['runs'][0]['prompt'])
        self.assertIn('实际输出 中文', embedded['runs'][0]['outputs'][0]['content'])

    def test_server_mode_is_rejected(self):
        result = self.run_helper('eval-viewer/generate_review.py', self.fixture(), check=False)
        self.assertEqual(result.returncode, 2)
        self.assertIn('--static', result.stderr)

    def test_benchmark_uses_actual_run_count_and_measured_tokens(self):
        iteration = self.fixture()
        self.run_helper('scripts/aggregate_benchmark.py', iteration, '--skill-name', '中文技能')
        data = json.loads((iteration / 'benchmark.json').read_text(encoding='utf-8'))
        self.assertEqual(data['metadata']['runs_per_configuration'], 1)
        self.assertEqual(sorted(run['result']['tokens'] for run in data['runs']), [20, 30])
        self.assertEqual(data['run_summary']['delta']['pass_rate'], '+1.00')
        self.assertIn('中文技能', (iteration / 'benchmark.md').read_text(encoding='utf-8'))

    def test_benchmark_rejects_missing_measurements_instead_of_using_characters(self):
        iteration = self.fixture(with_timing=False)
        result = self.run_helper('scripts/aggregate_benchmark.py', iteration, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Missing measured elapsed time or token usage', result.stderr)
        self.assertFalse((iteration / 'benchmark.json').exists())

    def test_updated_skill_delta_compares_new_against_old(self):
        iteration = self.fixture()
        case = iteration / 'eval-0-中文'
        (case / 'without_skill').rename(case / 'old_skill')
        self.run_helper('scripts/aggregate_benchmark.py', iteration)
        data = json.loads((iteration / 'benchmark.json').read_text(encoding='utf-8'))
        self.assertEqual(list(data['run_summary'])[:2], ['with_skill', 'old_skill'])
        self.assertEqual(data['run_summary']['delta']['pass_rate'], '+1.00')

    def test_trigger_report_preserves_utf8(self):
        source = self.root / '描述测试.json'
        output = self.root / '描述报告.html'
        source.write_text(json.dumps({'history': [{
            'iteration': 1, 'description': '中文说明', 'passed': 1, 'total': 1,
            'results': [{'query': '处理中文文件', 'should_trigger': True, 'pass': True, 'triggers': 1, 'runs': 1}],
        }], 'holdout': 0}, ensure_ascii=False), encoding='utf-8')
        self.run_helper('scripts/generate_report.py', source, '--skill-name', '中文技能', '--output', output)
        page = output.read_text(encoding='utf-8')
        self.assertIn('中文技能', page)
        self.assertIn('处理中文文件', page)
        parser = PageResources()
        parser.feed(page)
        self.assertEqual(parser.remote, [])
        stdout_result = self.run_helper('scripts/generate_report.py', source, '--skill-name', '中文技能')
        self.assertIn('中文技能', stdout_result.stdout)
        self.assertIn('✓', stdout_result.stdout)

    def test_review_templates_do_not_request_remote_assets(self):
        for relative in ('assets/eval_review.html', 'eval-viewer/viewer.html'):
            with self.subTest(template=relative):
                parser = PageResources()
                parser.feed((ROOT / relative).read_text(encoding='utf-8'))
                self.assertEqual(parser.remote, [])

    @unittest.skipUnless(os.name == 'nt' and importlib.util.find_spec('playwright'),
                         'requires Windows, optional Python Playwright, and installed Edge')
    def test_offline_viewer_renders_evidence_and_downloads_feedback(self):
        from playwright.sync_api import sync_playwright

        iteration = self.fixture()
        run = iteration / 'eval-0-中文/with_skill/run-1'
        grading = json.loads((run / 'grading.json').read_text(encoding='utf-8'))
        grading['expectations'][0]['evidence'] = 'Uses " data-review-probe="injected'
        (run / 'grading.json').write_text(json.dumps(grading), encoding='utf-8')
        (run / 'outputs/workbook.xlsx').write_bytes(b'workbook-download-fixture')
        self.run_helper('scripts/aggregate_benchmark.py', iteration)
        output = self.root / 'review.html'
        self.run_helper('eval-viewer/generate_review.py', iteration, '--static', output,
                        '--benchmark', iteration / 'benchmark.json')
        unexpected_requests = []
        url = 'http://skill-review.invalid/review.html'

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel='msedge', headless=True)
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()

            def route(request):
                if request.request.url == url:
                    request.fulfill(status=200, content_type='text/html', body=output.read_text(encoding='utf-8'))
                else:
                    unexpected_requests.append(request.request.url)
                    request.fulfill(status=404, body='No review server')

            context.route('**/*', route)
            page.goto(url)
            self.assertEqual(page.locator('[data-review-probe]').count(), 0)
            self.assertEqual(page.evaluate('typeof window.injected'), 'undefined')
            self.assertIn('Inline spreadsheet preview is unavailable', page.locator('#outputs-body').inner_text())
            self.assertEqual(page.locator('a[download="workbook.xlsx"]').count(), 1)
            page.locator('#feedback').fill('中文反馈')
            with page.expect_download() as download:
                page.locator('#done-btn').click()
            feedback = self.root / 'feedback.json'
            download.value.save_as(feedback)
            data = json.loads(feedback.read_text(encoding='utf-8'))
            self.assertEqual(data['status'], 'complete')
            self.assertTrue(any(review['feedback'] == '中文反馈' for review in data['reviews']))
            self.assertEqual(unexpected_requests, [])
            context.close()
            browser.close()


if __name__ == '__main__':
    unittest.main()
