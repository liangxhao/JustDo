import importlib.util
import json
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]


def test_setup_generates_isolated_config_without_overwriting(tmp_path):
    spec = importlib.util.spec_from_file_location('integration_setup', ROOT / 'tests/integration/setup.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    destination = tmp_path / 'tests/integration'
    (destination / 'jwt-service').mkdir(parents=True)
    (tmp_path / 'docker').mkdir()
    (tmp_path / 'docker/config.yaml').write_text((ROOT / 'docker/config.yaml').read_text())
    module.__file__ = str(destination / 'setup.py')
    module.main()
    login = json.loads((destination / 'state/login.json').read_text())
    assert len(login['mtoken']) >= 32
    assert yaml.safe_load((destination / 'config.yaml').read_text())['model_list'][0]['model_name'] == 'auth-test-model'
    original = (destination / '.env').read_bytes()
    with pytest.raises(SystemExit, match='refusing to overwrite'):
        module.main()
    assert (destination / '.env').read_bytes() == original


def test_integration_compose_is_isolated_and_waits_for_bootstrap_dependencies():
    config = yaml.safe_load((ROOT / 'tests/integration/docker-compose.yml').read_text())
    assert config['name'] == 'litellm-integration'
    assert config['services']['litellm']['build']['context'] == '../..'
    assert config['services']['bootstrap']['depends_on']['litellm']['condition'] == 'service_healthy'
    assert all(port.startswith('127.0.0.1:') for port in config['services']['jwt']['ports'])
