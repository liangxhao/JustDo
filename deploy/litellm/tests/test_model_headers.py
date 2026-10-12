from unittest.mock import AsyncMock

import pytest

from hooks.model_headers import ACCOUNT, MAX_COOKIE_BYTES, valid_cookie, wrap
from register import build_app

HEADERS = [(b'x-user-account', b'h00658810'), (b'x-cookie', b'sid=example; lang=zh')]


@pytest.mark.parametrize('account', [b'h00658810', b'Abc123456', b'A' + b'x' * 5 + b'123456'])
def test_valid_accounts(account):
    assert ACCOUNT.fullmatch(account)


@pytest.mark.parametrize('account', [b'', b'h1234567', b'100658810', b'h0065881x',
    b'h_0658810', b'h00658810\n', b'h00658810 ', b'A' + b'x' * 6 + b'123456'])
def test_invalid_accounts(account):
    assert not ACCOUNT.fullmatch(account)


@pytest.mark.parametrize('cookie', [b'sid=abc', b'sid=abc==; token=a%20b', b'sid="abc="',
    b'empty=', b'sid=a; sid=b', b'sid=' + b'x' * (MAX_COOKIE_BYTES - 4),
    b'sid=abc;', b'sid=abc; lang=zh; '])
def test_cookie_pair_syntax(cookie):
    assert valid_cookie(cookie)


@pytest.mark.parametrize('cookie', [b'', b' ', b'raw-token', b'=value', b'bad name=value',
    b'sid=a\r\nInjected: value', b'sid=a\x00', b'sid=\xff', b'sid=a,b', b'sid=a\\b',
    b'sid="unterminated', b'sid=a b', b'sid=a;;x=b', b'sid=a; HttpOnly',
    b';', b'sid=a;\r\n', b'sid=' + b'x' * (MAX_COOKIE_BYTES - 3)])
def test_invalid_cookie_syntax(cookie):
    assert not valid_cookie(cookie)


async def invoke(path, headers=HEADERS, kind='http', method='POST', registered=False):
    downstream, receive, send = AsyncMock(), AsyncMock(), AsyncMock()
    app = build_app(downstream, {'LITELLM_HOOKS': ''}) if registered else wrap(downstream, {})
    scope = {'type': kind, 'path': path, 'method': method, 'headers': headers}
    await app(scope, receive, send)
    return downstream, receive, send


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/v1/chat/completions', '/chat/completions/', '/v1/embeddings',
    '/v1/responses', '/v1/responses/test', '/v1/messages', '/images/generations',
    '/openai/deployments/demo/chat/completions', '/v1/audio/transcriptions'])
async def test_missing_headers_rejected_before_body_read_or_model_call(path):
    downstream, receive, send = await invoke(path, headers=[])
    downstream.assert_not_awaited()
    receive.assert_not_awaited()
    assert send.call_args_list[0].args[0]['status'] == 400


@pytest.mark.asyncio
@pytest.mark.parametrize('headers', [HEADERS[:1], HEADERS[1:], HEADERS + HEADERS[:1],
    HEADERS + [(b'X-Cookie', b'other=secret')],
    [(b'x-user-account', b'h00658810'), (b'x-cookie', b'secret-raw-token')]])
async def test_missing_invalid_or_duplicate_headers_never_reach_model(headers):
    downstream, _, send = await invoke('/v1/chat/completions', headers=headers)
    downstream.assert_not_awaited()
    assert send.call_args_list[0].args[0]['status'] == 400
    assert b'secret' not in send.call_args_list[1].args[0]['body']


@pytest.mark.asyncio
@pytest.mark.parametrize('authorization', [b'Bearer sk-legacy', b'Bearer a.b.c'])
async def test_registered_hook_requires_headers_for_both_key_and_jwt(authorization):
    downstream, _, _ = await invoke('/v1/chat/completions', headers=[(b'authorization', authorization)], registered=True)
    downstream.assert_not_awaited()
    downstream, _, send = await invoke('/v1/chat/completions', headers=[*HEADERS, (b'authorization', authorization)], registered=True)
    downstream.assert_awaited_once()
    send.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/health/liveliness', '/health/readiness', '/ui', '/team/update',
    '/key/generate', '/customer/activity', '/models', '/v1/models', '/model/info'])
async def test_management_health_and_discovery_are_not_intercepted(path):
    downstream, _, _ = await invoke(path, headers=[])
    downstream.assert_awaited_once()


@pytest.mark.asyncio
async def test_preflight_lifespan_and_realtime_handshake():
    downstream, _, _ = await invoke('/v1/chat/completions', headers=[], method='OPTIONS')
    downstream.assert_awaited_once()
    downstream, _, _ = await invoke('', headers=[], kind='lifespan')
    downstream.assert_awaited_once()
    downstream, _, send = await invoke('/v1/realtime', headers=[], kind='websocket')
    downstream.assert_not_awaited()
    send.assert_awaited_once()
    closed = send.call_args.args[0]
    assert closed['type'] == 'websocket.close' and closed['code'] == 1008
    assert closed['reason'].startswith('REQ-1042:')
    downstream, _, _ = await invoke('/v1/realtime', kind='websocket')
    downstream.assert_awaited_once()


@pytest.mark.asyncio
async def test_valid_headers_preserve_streaming_response_and_body_receiver():
    receive, send = AsyncMock(), AsyncMock()
    parts = [
        {'type': 'http.response.start', 'status': 200, 'headers': []},
        {'type': 'http.response.body', 'body': b'first', 'more_body': True},
        {'type': 'http.response.body', 'body': b'last', 'more_body': False},
    ]
    async def downstream(scope, actual_receive, actual_send):
        assert actual_receive is receive
        for index, part in enumerate(parts):
            await actual_send(part)
            assert send.await_count == index + 1
    await wrap(downstream, {})({
        'type': 'http', 'path': '/v1/chat/completions', 'method': 'POST',
        'headers': [(b'X-User-Account', b'h00658810'), (b'X-Cookie', b'sid=value')],
    }, receive, send)
    receive.assert_not_awaited()
    assert [call.args[0] for call in send.call_args_list] == parts
