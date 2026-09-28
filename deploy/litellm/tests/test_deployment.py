"""Single-instance deployment invariants."""
from pathlib import Path
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_docker_passes_configurable_prompt_storage_limit():
    compose = yaml.safe_load((ROOT / 'docker/docker-compose.yml').read_text())
    environment = compose['services']['litellm']['environment']

    assert environment['MAX_STRING_LENGTH_PROMPT_IN_DB'] == '${MAX_STRING_LENGTH_PROMPT_IN_DB:-100000}'
    assert 'MAX_STRING_LENGTH_PROMPT_IN_DB=100000' in (ROOT / 'docker/.env.example').read_text()


@pytest.mark.parametrize('name', ['docker', 'native'])
def test_logging_forwarding_and_preview_settings(name):
    config = yaml.safe_load((ROOT / name / 'config.yaml').read_text())
    settings = config['general_settings']

    assert settings['store_prompts_in_spend_logs'] is True
    assert settings['disable_spend_logs'] is False
    assert settings['forward_client_headers_to_llm_api'] is True
    assert settings['user_header_name'] == 'X-User-Account'
    assert config['litellm_settings']['enable_preview_features'] is True
    assert settings['database_connection_pool_limit'] == 4
    assert settings['database_connection_timeout'] == 30
    assert settings['proxy_batch_write_at'] == 60
    assert settings['disable_error_logs'] is False
    assert settings['always_include_stream_usage'] is True
    assert config['litellm_settings']['set_verbose'] is False
    assert config['litellm_settings']['json_logs'] is True
    assert config['litellm_settings']['drop_params'] is True
    assert config['litellm_settings']['request_timeout'] == 1800
    assert config['router_settings']['timeout'] == 1800
    assert config['router_settings']['stream_timeout'] == 1800
    assert config['router_settings']['num_retries'] == 2


@pytest.mark.parametrize('role', ['customer', 'Customer'])
@pytest.mark.parametrize('fallback_only', [False, True])
def test_native_end_user_mapping_and_legacy_header_setting(monkeypatch, role, fallback_only):
    from litellm.proxy import proxy_server
    from litellm.proxy.auth.auth_utils import get_end_user_id_from_request_body

    settings = {'user_header_name': 'X-User-Account'}
    if not fallback_only:
        settings = {'user_header_mappings': [
            {'header_name': 'X-User-Account', 'litellm_user_role': role},
        ]}

    monkeypatch.setattr(proxy_server, 'general_settings', settings)
    assert get_end_user_id_from_request_body(
        {}, {'x-user-account': 'h00658810'},
    ) == 'h00658810'


def test_compose_exposes_exactly_one_litellm_service():
    services = yaml.safe_load((ROOT / 'docker/docker-compose.yml').read_text())['services']
    assert set(services) == {'litellm', 'db', 'redis', 'init'}
    assert services['init']['restart'] == 'no'
    assert 'ports' not in services['init']
    assert services['init']['entrypoint'] == ['python', '/opt/litellm-hooks/start.py', 'init']
    assert services['litellm']['depends_on']['init']['condition'] == 'service_completed_successfully'
    assert 'UI_PASSWORD' in services['litellm']['environment']
    service = services['litellm']
    assert service['ports'] == ['${LITELLM_PORT:-9108}:4000']
    assert service['depends_on']['redis']['condition'] == 'service_healthy'
    assert 'LITELLM_JWT_ISSUER' in service['environment']
    assert 'LITELLM_ACTIVITY_TOKEN' in service['environment']
    assert 'ports' not in services['db']
    assert 'ports' not in services['redis']
    assert service['ulimits']['nofile']['soft'] >= 16384


def test_both_deployment_methods_use_one_config_and_the_same_authorization():
    for name in ('docker', 'native'):
        directory = ROOT / name
        assert sorted(p.name for p in directory.glob('config*.yaml')) == ['config.yaml']
        assert not (directory / 'nginx.conf').exists()
        settings = yaml.safe_load((directory / 'config.yaml').read_text())['general_settings']
        assert settings['disable_prisma_schema_update'] is True
        assert settings['custom_auth_run_common_checks'] is True
        assert settings['custom_auth'] == 'hooks.jwt_auth.handler.user_api_key_auth'
    assert 'COPY hooks' in (ROOT / 'docker/Dockerfile').read_text()


def test_mounts_and_service_paths_exist():
    services = yaml.safe_load((ROOT / 'docker/docker-compose.yml').read_text())['services']
    for service in services.values():
        for mount in service.get('volumes', []):
            source = mount.split(':', 1)[0]
            if source.startswith('.'):
                assert (ROOT / 'docker' / source).is_file()
    unit = (ROOT / 'native/litellm.service').read_text()
    assert 'User=litellm' in unit
    assert 'start.py %i' not in unit
    assert 'LimitNOFILE=16384' in unit
