"""Native launcher invariants, without contacting a real database or issuer."""

import importlib.util
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


def load_script(name):
    path = Path(__file__).resolve().parents[1] / 'native' / f'{name}.py'
    spec = importlib.util.spec_from_file_location(f'native_{name}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def launcher(tmp_path, monkeypatch):
    module = load_script('start')
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    (tmp_path / '.env').write_text(
        'DATABASE_URL=postgresql://user:secret@localhost/db\n'
        'LITELLM_MASTER_KEY=master-secret\nLITELLM_SALT_KEY=salt-secret\n'
        'UI_USERNAME=admin\nUI_PASSWORD=test-only-password\n'
        'REDIS_HOST=localhost\nREDIS_PORT=6379\nREDIS_PASSWORD=literal${DOLLAR}\n'
        'LITELLM_JWT_ISSUER=https://login.test\nLITELLM_JWT_AUDIENCE=audience\n'
        'LITELLM_JWT_JWKS_URL=https://login.test/jwks\n'
        'LITELLM_ACTIVITY_DATABASE_URL=postgresql://user:secret@localhost/db\n'
    )
    return module


def test_serve_requires_dashboard_password(launcher):
    config_file = launcher.ROOT / '.env'
    config_file.write_text(config_file.read_text().replace('UI_PASSWORD=test-only-password', 'UI_PASSWORD='))
    with pytest.raises(ValueError, match='required deployment settings'):
        launcher.build_launch('serve', {})


def test_launch_uses_venv_tools_loopback_and_literal_secrets(launcher):
    command, environment = launcher.build_launch('serve', {'PATH': 'system-bin', 'REDIS_PASSWORD': 'wrong'})
    assert environment['PATH'].split(os.pathsep)[0] == str(Path(launcher.sys.executable).parent)
    assert environment['REDIS_PASSWORD'] == 'literal${DOLLAR}'
    assert command[command.index('--host') + 1] == '127.0.0.1'
    assert command[command.index('--port') + 1] == '9108'
    assert command[command.index('--workers') + 1] == '4'
    assert 'secret' not in ' '.join(command)
    assert 'start:create_app' in command
    assert environment['DISABLE_SCHEMA_UPDATE'] == 'true'


def test_unknown_plane_is_rejected(launcher):
    with pytest.raises(ValueError, match='Unknown launch mode'):
        launcher.build_launch('typo')


def test_missing_configuration_is_rejected_without_values(launcher):
    (launcher.ROOT / '.env').write_text('DATABASE_URL=postgresql://secret@localhost/db\n')
    with pytest.raises(ValueError) as error:
        launcher.build_launch('serve', {})
    assert 'secret' not in str(error.value)


def test_installation_provides_venv_generator_executables(tmp_path, monkeypatch):
    installer = load_script('install')
    monkeypatch.setattr(installer, 'ROOT', tmp_path)
    monkeypatch.setattr(installer.sys, 'version_info', (3, 12))
    builder = Mock()
    monkeypatch.setattr(installer.venv, 'EnvBuilder', Mock(return_value=builder))
    runner = Mock()
    monkeypatch.setattr(installer.subprocess, 'run', runner)
    installer.main([])
    assert runner.call_count == 2
    expected = tmp_path / '.venv' / ('Scripts' if os.name == 'nt' else 'bin')
    for call in runner.call_args_list:
        assert call.kwargs['env']['PATH'].split(os.pathsep)[0] == str(expected)
        assert call.kwargs['check'] is True


def test_explicit_init_runs_migrations_separately_from_workers(launcher):
    command, environment = launcher.build_launch('init', {})
    assert command[-2].endswith('start.py') and command[-1] == 'init'
    assert 'uvicorn' not in command
    assert environment['LITELLM_ACTIVITY_DATABASE_URL'].startswith('postgresql:')


def test_launcher_executes_without_logging_environment(launcher, monkeypatch):
    monkeypatch.setattr(launcher.sys, 'argv', ['start.py'])
    execute = Mock()
    monkeypatch.setattr(launcher.os, 'execve', execute)
    launcher.main()
    execute.assert_called_once()


def test_environment_file_overrides_inherited_settings_including_empty_team(launcher):
    path = launcher.ROOT / '.env'
    path.write_text(path.read_text() + '\nLITELLM_DEFAULT_TEAM_ID=\n')
    _, environment = launcher.build_launch('serve', {
        'LITELLM_JWT_AUDIENCE': 'inherited', 'LITELLM_DEFAULT_TEAM_ID': 'inherited-team'})
    assert environment['LITELLM_JWT_AUDIENCE'] == 'audience'
    assert environment['LITELLM_DEFAULT_TEAM_ID'] == ''


def test_existing_virtualenv_install_does_not_create_an_environment(tmp_path, monkeypatch):
    installer = load_script('install')
    monkeypatch.setattr(installer.sys, 'version_info', (3, 12))
    monkeypatch.setattr(installer.sys, 'prefix', str(tmp_path / 'external'))
    monkeypatch.setattr(installer.sys, 'base_prefix', str(tmp_path / 'base'))
    python = str(tmp_path / 'external' / 'bin' / 'python')
    monkeypatch.setattr(installer.sys, 'executable', python)
    builder, runner = Mock(), Mock()
    monkeypatch.setattr(installer.venv, 'EnvBuilder', builder)
    monkeypatch.setattr(installer.subprocess, 'run', runner)
    installer.main(['--existing-env'])
    builder.assert_not_called()
    assert runner.call_count == 2
    for call in runner.call_args_list:
        assert call.args[0][0] == python
        assert call.kwargs['env']['PATH'].split(os.pathsep)[0] == str(Path(python).parent)


def test_existing_environment_mode_rejects_system_python(monkeypatch):
    installer = load_script('install')
    monkeypatch.setattr(installer.sys, 'version_info', (3, 12))
    monkeypatch.setattr(installer.sys, 'prefix', installer.sys.base_prefix)
    runner = Mock()
    monkeypatch.setattr(installer.subprocess, 'run', runner)
    with pytest.raises(SystemExit, match='virtual environment Python'):
        installer.main(['--existing-env'])
    runner.assert_not_called()


def test_native_network_and_offline_settings_reach_worker(launcher):
    path = launcher.ROOT / '.env'
    path.write_text(path.read_text() + '\nLITELLM_HOST=0.0.0.0\nLITELLM_PORT=4000\n'
                    'LITELLM_WORKERS=8\nMAX_STRING_LENGTH_PROMPT_IN_DB=100000\n'
                    'PRISMA_QUERY_ENGINE_BINARY=/engines/query-engine\n'
                    'PRISMA_SCHEMA_ENGINE_BINARY=/engines/schema-engine\n'
                    'LITELLM_LOCAL_MODEL_COST_MAP=True\n')
    command, environment = launcher.build_launch('serve', {})
    assert command[command.index('--host') + 1] == '0.0.0.0'
    assert command[command.index('--port') + 1] == '4000'
    assert command[command.index('--workers') + 1] == '8'
    assert environment['MAX_STRING_LENGTH_PROMPT_IN_DB'] == '100000'
    assert environment['PRISMA_QUERY_ENGINE_BINARY'] == '/engines/query-engine'
    assert environment['PRISMA_SCHEMA_ENGINE_BINARY'] == '/engines/schema-engine'
    assert environment['LITELLM_LOCAL_MODEL_COST_MAP'] == 'True'
    assert environment['PYTHONUNBUFFERED'] == '1'
    assert 'REQUESTS_CA_BUNDLE' not in environment
    assert 'CURL_CA_BUNDLE' not in environment


@pytest.mark.parametrize('setting', ['LITELLM_PORT=0', 'LITELLM_PORT=65536',
    'LITELLM_WORKERS=0', 'LITELLM_WORKERS=bad', 'MAX_STRING_LENGTH_PROMPT_IN_DB=-1',
    'MAX_STRING_LENGTH_PROMPT_IN_DB=bad', 'LITELLM_HOST='])
def test_invalid_runtime_settings_fail_before_launch(launcher, setting):
    path = launcher.ROOT / '.env'
    path.write_text(path.read_text() + '\n' + setting + '\n')
    with pytest.raises(ValueError):
        launcher.build_launch('serve', {})
