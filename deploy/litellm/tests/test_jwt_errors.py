import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import jwt
import pytest
from fastapi import Request

from hooks.jwt_auth import handler
from hooks.jwt_auth.errors import JwtAuthError, JwtFailure
from hooks.activity.middleware import ActivityHook


@pytest.mark.parametrize('failure', list(JwtFailure))
@pytest.mark.asyncio
async def test_litellm_native_exception_response_preserves_shared_error_envelope(failure, caplog):
    from litellm.proxy.proxy_server import openai_exception_handler
    caplog.set_level(logging.WARNING, logger='litellm.validation')
    error = JwtAuthError(failure)
    response = await openai_exception_handler(Request({'type': 'http'}), error)
    payload = json.loads(response.body)['error']
    code, status, message = failure.value
    assert response.status_code == status
    assert payload == {'type': 'auth_error', 'code': code, 'message': message,
                       'request_id': error.details.request_id}
    assert UUID(payload['request_id']).version == 4
    assert response.headers['x-request-id'] == payload['request_id']
    assert response.headers['cache-control'] == 'no-store'
    assert payload['request_id'] in caplog.text
    assert f'reason={failure.name.lower()}' in caplog.text


@pytest.mark.parametrize('underlying,expected', [
    (jwt.PyJWKClientConnectionError('secret-endpoint'), JwtFailure.JWKS),
    (jwt.PyJWKClientError('secret-kid'), JwtFailure.SIGNING_KEY),
    (RuntimeError('secret-internal-detail'), JwtFailure.INTERNAL),
])
@pytest.mark.asyncio
async def test_key_service_failures_never_expose_underlying_values(monkeypatch, caplog, underlying, expected):
    monkeypatch.setattr(handler, 'load_settings', lambda: SimpleNamespace(algorithms=('RS256',)))
    monkeypatch.setattr(jwt, 'get_unverified_header', lambda _: {'alg': 'RS256', 'kid': 'test'})
    def fail(*args):
        raise underlying
    monkeypatch.setattr(handler, '_get_jwks_client', lambda: SimpleNamespace(get_signing_key_from_jwt=fail))
    with pytest.raises(JwtAuthError) as rejected:
        await handler.decode_and_validate_token('private-token')
    error = rejected.value
    assert error.to_dict()['code'] == expected.value[0]
    assert error.__suppress_context__
    assert 'secret-' not in str(error.to_dict()) + caplog.text
    assert 'private-token' not in str(error.to_dict()) + caplog.text


@pytest.mark.asyncio
async def test_unexpected_auth_failure_uses_safe_error_and_never_returns_a_principal(monkeypatch, caplog):
    monkeypatch.setattr(handler, '_authenticate', AsyncMock(side_effect=RuntimeError('sensitive-db-url')))
    with pytest.raises(JwtAuthError) as rejected:
        await handler.user_api_key_auth(Request({'type': 'http'}), 'private-token')
    assert rejected.value.to_dict()['code'] == 'JWT-1503'
    assert 'sensitive-db-url' not in str(rejected.value) + caplog.text


@pytest.mark.asyncio
async def test_activity_preserves_jwt_error_id_status_and_does_not_write_store():
    error = JwtAuthError(JwtFailure.EXPIRED)
    store, downstream, receive, send = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
    hook = ActivityHook(downstream, store, authenticate=AsyncMock(side_effect=error))
    await hook({'type': 'http', 'path': '/user/activity', 'method': 'POST',
                'headers': [(b'x-access-jwt', b'private-token')]}, receive, send)
    assert send.call_args_list[0].args[0]['status'] == 401
    assert json.loads(send.call_args_list[1].args[0]['body']) == {'error': error.to_dict()}
    store.record.assert_not_awaited()
    receive.assert_not_awaited()


def test_jwt_diagnostic_codes_are_unique():
    assert len({failure.value[0] for failure in JwtFailure}) == len(JwtFailure)


def test_all_codes_are_documented():
    from pathlib import Path
    text = (Path(__file__).resolve().parents[1] / 'hooks' / 'ERRORS.md').read_text(encoding='utf-8')
    for failure in JwtFailure:
        assert f'| {failure.value[0]} | {failure.value[1]} |' in text


@pytest.mark.asyncio
async def test_configuration_failure_is_safe_and_distinct(monkeypatch, caplog):
    def fail():
        raise RuntimeError('private-configuration-value')
    monkeypatch.setattr(handler, 'load_settings', fail)
    with pytest.raises(JwtAuthError) as rejected:
        await handler.decode_and_validate_token('private-token')
    assert rejected.value.to_dict()['code'] == 'JWT-1501'
    assert 'private-' not in str(rejected.value.to_dict()) + caplog.text


@pytest.mark.asyncio
async def test_missing_auth_callback_never_falls_back_to_native():
    from hooks.jwt_auth.dispatch import dispatch
    request = Request({'type': 'http', 'headers': [(b'x-access-jwt', b'a.b.c')]})
    with pytest.raises(JwtAuthError) as rejected:
        await dispatch(request, 'sk-master', None)
    assert rejected.value.to_dict()['code'] == 'JWT-1501'
