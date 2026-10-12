"""Required model-request header checks, independent of JWT/native key auth."""

import re

from .errors import Failure, reject

ACCOUNT = re.compile(rb'[A-Za-z][A-Za-z0-9]{2,5}[0-9]{6}')
COOKIE_NAME = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
COOKIE_VALUE = re.compile(rb'[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*')
MAX_COOKIE_BYTES = 16 * 1024
DISCOVERY_ROUTES = frozenset({
    '/models', '/v1/models', '/cursor/models', '/cursor/v1/models',
    '/model/info', '/v1/model/info', '/model_group/info',
})


def valid_cookie(value):
    # RFC 6265 cookie-pair syntax. This does not establish session validity.
    if not value or len(value) > MAX_COOKIE_BYTES:
        return False
    if any(byte < 32 or byte >= 127 for byte in value):
        return False

    for pair in value.rstrip(b'; ').split(b';'):
        name, separator, content = pair.strip(b' ').partition(b'=')
        if not separator or not COOKIE_NAME.fullmatch(name):
            return False
        if content.startswith(b'"') and content.endswith(b'"') and len(content) >= 2:
            content = content[1:-1]
        if not COOKIE_VALUE.fullmatch(content):
            return False

    return True


def validate_headers(headers):
    accounts, cookies = [], []
    for name, value in headers:
        name = name.lower()
        if name == b'x-user-account':
            accounts.append(value)
        elif name == b'x-cookie':
            cookies.append(value)

    if not accounts:
        return Failure.ACCOUNT_MISSING
    if len(accounts) != 1:
        return Failure.ACCOUNT_DUPLICATE
    if not ACCOUNT.fullmatch(accounts[0]):
        return Failure.ACCOUNT_INVALID

    if not cookies:
        return Failure.COOKIE_MISSING
    if len(cookies) != 1:
        return Failure.COOKIE_DUPLICATE
    if not valid_cookie(cookies[0]):
        return Failure.COOKIE_INVALID

    return None


class ModelHeadersHook:
    def __init__(self, app):
        from litellm.proxy._types import LiteLLMRoutes
        from litellm.proxy.auth.route_checks import RouteChecks

        self.app = app
        self.routes = LiteLLMRoutes.llm_api_routes.value
        self.matches = RouteChecks.check_route_access

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '').rstrip('/')
        protected = (scope['type'] in {'http', 'websocket'}
                     and scope.get('method') != 'OPTIONS'
                     and path not in DISCOVERY_ROUTES
                     and self.matches(path, self.routes))

        error = validate_headers(scope.get('headers', [])) if protected else None
        if error is None:
            await self.app(scope, receive, send)
            return

        await reject(scope, send, error)


def wrap(app, environ):
    return ModelHeadersHook(app)
