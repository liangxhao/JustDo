import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize('exit_code', [0, 1])
def test_up_starts_only_after_successful_initialization(monkeypatch, exit_code):
    path = Path(__file__).resolve().parents[1] / 'native/start.py'
    spec = importlib.util.spec_from_file_location('native_up', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    events = []
    monkeypatch.setattr(module.sys, 'argv', ['start.py', 'up'])
    monkeypatch.setattr(module, 'build_launch', lambda mode: ([mode], {'MODE': mode}))

    def run(command, **kwargs):
        events.append(command[0])
        return SimpleNamespace(returncode=exit_code)

    monkeypatch.setattr(module.subprocess, 'run', run)
    monkeypatch.setattr(module.os, 'execve', lambda *args: events.append('serve'))
    if exit_code:
        with pytest.raises(SystemExit) as error:
            module.main()
        assert error.value.code == 1
        assert events == ['init']
    else:
        module.main()
        assert events == ['init', 'serve']
