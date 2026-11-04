import json
from unittest.mock import AsyncMock

import pytest

from hooks.activity import wrap
from hooks.activity.middleware import ActivityHook
from hooks.activity.events import validate_event
from hooks.jwt_auth.errors import JwtAuthError, JwtFailure
from hooks.jwt_auth.identity import authenticate_jwt


EVENT = {'event_id': '822f78cc-bd26-4e13-a42a-b45060a330da',
         'user_id': 'alice', 'event_type': 'startup'}


async def request(hook, event=EVENT, token='a.b.c', jwt_header=None):
    send = AsyncMock()
    headers = [(b'authorization', ('Bearer ' + token).encode())]
    if jwt_header is not None:
        headers.append((b'x-access-jwt', jwt_header.encode()))
    await hook({'type': 'http', 'path': '/user/activity', 'method': 'POST',
                'headers': headers},
               AsyncMock(return_value={'type': 'http.request', 'body': json.dumps(event).encode()}), send)
    return send.call_args_list[0].args[0]['status']


@pytest.mark.asyncio
async def test_authenticated_subject_reports_only_own_activity():
    store = AsyncMock()
    hook = ActivityHook(AsyncMock(), store, authenticate=AsyncMock(return_value='alice'))
    assert await request(hook) == 200
    store.record.assert_awaited_once_with(validate_event(EVENT))
    store.record.reset_mock()
    assert await request(hook, {**EVENT, 'user_id': 'bob'}) == 403
    store.record.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_jwt_never_falls_back_to_shared_activity_token():
    store = AsyncMock()
    validator = AsyncMock(side_effect=JwtAuthError(JwtFailure.INVALID))
    hook = ActivityHook(AsyncMock(), store, authenticate=validator)
    assert await request(hook, token='old-shared-token-with-at-least-32-characters', jwt_header='invalid') == 401
    validator.assert_awaited_once()
    store.record.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_authenticated_subject_cannot_write_activity():
    store = AsyncMock()
    hook = ActivityHook(AsyncMock(), store, authenticate=AsyncMock(return_value=None))
    assert await request(hook) == 401
    store.record.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_user_is_not_registered_by_activity():
    store = AsyncMock()
    store.record.side_effect = LookupError('User does not exist')
    hook = ActivityHook(AsyncMock(), store, authenticate=AsyncMock(return_value='alice'))
    assert await request(hook) == 404


@pytest.mark.asyncio
async def test_activity_uses_the_same_jwt_and_team_validator(monkeypatch):
    from types import SimpleNamespace
    from hooks.jwt_auth import handler as custom_auth

    validator = AsyncMock(return_value=SimpleNamespace(user_id='alice', team_blocked=False))
    monkeypatch.setattr(custom_auth, 'user_api_key_auth', validator)
    scope = {'type': 'http', 'path': '/user/activity', 'method': 'POST', 'headers': [
        (b'x-access-jwt', b'token'), (b'x-user-account', b'alice'),
        (b'authorization', b'Bearer access-jwt-auth')]}
    assert await authenticate_jwt(scope) == 'alice'
    assert validator.call_args.args[0].headers['x-access-jwt'] == 'token'
    validator.return_value.team_blocked = True
    with pytest.raises(JwtAuthError, match='Team is blocked'):
        await authenticate_jwt(scope)


@pytest.mark.asyncio
@pytest.mark.parametrize('token', ['', 'sk-native-key', 'old-shared-token-with-at-least-32-characters'])
async def test_non_jwt_credentials_cannot_report_through_real_identity_validator(monkeypatch, token):
    from hooks.jwt_auth import handler as custom_auth

    decode = AsyncMock()
    monkeypatch.setattr(custom_auth, 'decode_and_validate_token', decode)
    store = AsyncMock()
    hook = ActivityHook(AsyncMock(), store, authenticate=authenticate_jwt)
    assert await request(hook, token=token) == 401
    decode.assert_not_awaited()
    store.record.assert_not_awaited()


def test_activity_needs_only_database_configuration_and_jwt():
    hook = wrap(AsyncMock(), {'LITELLM_ACTIVITY_DATABASE_URL': 'postgresql://localhost/db'})
    assert hook.authenticate is authenticate_jwt
