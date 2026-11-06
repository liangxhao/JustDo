"""Check both launch methods use the single shared implementation."""
from pathlib import Path
import subprocess
import sys
import unittest


class DeploymentLayoutTests(unittest.TestCase):
    def test_shared_entrypoint_imports_without_litellm_installed(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, '-B', '-c', 'import start as proxy_app'],
            cwd=root,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_launchers_reference_shared_sources(self):
        root = Path(__file__).resolve().parents[1]
        script = (root / 'native' / 'start.sh').read_text()
        self.assertIn('"$SCRIPT_DIR/start.py"', script)
        launcher = (root / 'native' / 'start.py').read_text()
        self.assertIn('str(ROOT.parent)', launcher)
        self.assertIn('"--app-dir", str(ROOT.parent)', launcher)

        dockerfile = (root / 'docker' / 'Dockerfile').read_text()
        for name in ('hooks', 'requirements.txt', 'start.py register.py', 'logging.json'):
            self.assertIn('COPY ' + name, dockerfile)
        self.assertIn('"--log-config", "/opt/litellm-hooks/logging.json"', dockerfile)
        self.assertNotIn('"--no-access-log"', dockerfile)
        self.assertIn('!logging.json', (root / 'docker/Dockerfile.dockerignore').read_text())

        for directory in ('native', 'docker'):
            self.assertFalse((root / directory / 'proxy_app.py').exists())
            self.assertEqual(list((root / directory / 'proxy_hooks').rglob('*.py')), [])

        for name in ('__init__.py', 'middleware.py', 'events.py', 'store.py'):
            self.assertTrue((root / 'hooks' / 'activity' / name).is_file())

    def test_docker_runtime_preserves_base_image_user(self):
        root = Path(__file__).resolve().parents[1]
        dockerfile = (root / 'docker' / 'Dockerfile').read_text()
        runtime_stage = dockerfile.rsplit('FROM ${LITELLM_IMAGE}', 1)[1]
        self.assertNotIn('USER root', runtime_stage)
        self.assertIn('COPY --from=hook-dependencies', runtime_stage)
