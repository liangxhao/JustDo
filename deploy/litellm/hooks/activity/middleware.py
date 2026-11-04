"""HTTP endpoint, authorization policy, and request limits for activity."""

import asyncio
import json
import logging

from .events import MAX_BODY_BYTES, validate_event
from hooks.jwt_auth.errors import JwtAuthError

LOG = logging.getLogger("litellm.activity")
PATH = "/user/activity"


class ActivityHook:
    def __init__(self, app, store, authenticate):
        self.app = app
        self.store = store
        self.authenticate = authenticate

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'lifespan':
            try:
                await self.app(scope, receive, send)
            finally:
                await self.store.close()
            return

        if scope['type'] != 'http' or scope['path'] != PATH:
            await self.app(scope, receive, send)
            return

        try:
            identity = await self.authenticate(scope)
            if not isinstance(identity, str) or not identity.strip():
                raise PermissionError('Missing authenticated identity')
        except JwtAuthError as error:
            await error.details.send(scope, send)
            return
        except Exception:
            await self.respond(send, 401, {'error': 'Unauthorized'})
            return

        if scope['method'] != 'POST':
            await self.respond(send, 405, {'error': 'POST required'})
            return

        body = bytearray()
        try:
            async with asyncio.timeout(5):
                while True:
                    message = await receive()
                    if message['type'] == 'http.disconnect':
                        return

                    body.extend(message.get('body', b''))
                    if len(body) > MAX_BODY_BYTES:
                        await self.respond(send, 413, {'error': 'Body too large'})
                        return

                    if not message.get('more_body', False):
                        break

            event = validate_event(json.loads(body))
        except TimeoutError:
            await self.respond(send, 408, {'error': 'Request timeout'})
            return

        except (ValueError, KeyError, TypeError, AttributeError, UnicodeError, RecursionError):
            await self.respond(send, 400, {'error': 'Invalid activity event'})
            return

        try:
            async with asyncio.timeout(5):
                if event[1] != identity:
                    await self.respond(send, 403, {'error': 'User does not match authenticated identity'})
                    return

                await self.store.record(event)
        except LookupError:
            await self.respond(send, 404, {'error': 'User does not exist'})
            return

        except Exception:
            # Never log database URLs, credentials, or user payloads.
            LOG.warning('Activity persistence unavailable')
            await self.respond(send, 503, {'error': 'Activity storage unavailable'})
            return

        await self.respond(send, 200, {'ok': True})

    @staticmethod
    async def respond(send, status, value):
        body = json.dumps(value).encode()
        await send({
            'type': 'http.response.start',
            'status': status,
            'headers': [
                (b'content-type', b'application/json'),
                (b'cache-control', b'no-store'),
            ],
        })
        await send({'type': 'http.response.body', 'body': body})
