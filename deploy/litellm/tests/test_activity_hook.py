import json
import unittest
from unittest.mock import AsyncMock

from hooks.activity.middleware import ActivityHook
from hooks.activity.events import validate_event

EVENT = {
    'event_id': '822f78cc-bd26-4e13-a42a-b45060a330da',
    'user_id': 'alice', 'event_type': 'startup',
    'metadata': {'productName': 'Example', 'loginTime': '2026-09-22T09:00:00Z'},
}


class HookTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, body=None, path='/user/activity', method='POST', authenticate=None):
        self.store = AsyncMock()
        self.downstream = AsyncMock()
        self.authenticate = authenticate or AsyncMock(return_value='alice')
        self.hook = ActivityHook(self.downstream, self.store, self.authenticate)
        scope = {'type': 'http', 'path': path, 'method': method,
                 'headers': [(b'authorization', b'Bearer header.payload.signature')]}
        receive = AsyncMock(return_value={'type': 'http.request',
                                         'body': body if body is not None else json.dumps(EVENT).encode()})
        send = AsyncMock()
        await self.hook(scope, receive, send)
        return send

    async def test_valid_event_persisted_before_success(self):
        send = await self.request()
        self.store.record.assert_awaited_once_with(validate_event(EVENT))
        self.assertEqual(send.call_args_list[0].args[0]['status'], 200)
        self.downstream.assert_not_awaited()

    async def test_bad_auth_cannot_write(self):
        send = await self.request(authenticate=AsyncMock(side_effect=PermissionError()))
        self.assertEqual(send.call_args_list[0].args[0]['status'], 401)
        self.store.record.assert_not_awaited()

    async def test_other_routes_pass_through(self):
        await self.request(path='/user/info')
        self.downstream.assert_awaited_once()
        self.store.record.assert_not_awaited()
        self.authenticate.assert_not_awaited()

    async def test_retired_customer_activity_is_not_admitted(self):
        await self.request(path='/customer/activity')
        self.downstream.assert_awaited_once()
        self.store.record.assert_not_awaited()
        self.authenticate.assert_not_awaited()

    async def test_read_method_does_not_persist_activity(self):
        send = await self.request(method='GET')
        self.assertEqual(send.call_args_list[0].args[0]['status'], 405)
        self.store.record.assert_not_awaited()

    async def test_body_limit(self):
        send = await self.request(body=b'x' * 8193)
        self.assertEqual(send.call_args_list[0].args[0]['status'], 413)
        self.store.record.assert_not_awaited()

    async def test_invalid_json(self):
        send = await self.request(body=b'{')
        self.assertEqual(send.call_args_list[0].args[0]['status'], 400)

    async def test_extremely_nested_json_is_a_controlled_rejection(self):
        body = b'{"event_id":"822f78cc-bd26-4e13-a42a-b45060a330da",' \
               b'"user_id":"alice","event_type":"custom.event","metadata":{"value":' + \
               b'[' * 1500 + b'null' + b']' * 1500 + b'}}'
        send = await self.request(body=body)
        self.assertEqual(send.call_args_list[0].args[0]['status'], 400)
        self.store.record.assert_not_awaited()

    async def test_non_finite_json_is_not_persisted(self):
        body = json.dumps({**EVENT, 'metadata': {'value': float('nan')}}).encode()
        send = await self.request(body=body)
        self.assertEqual(send.call_args_list[0].args[0]['status'], 400)
        self.store.record.assert_not_awaited()

    async def test_nul_in_nested_metadata_is_a_controlled_rejection(self):
        body = json.dumps({**EVENT, 'metadata': {'nested': ['invalid\x00text']}}).encode()
        send = await self.request(body=body)
        self.assertEqual(send.call_args_list[0].args[0]['status'], 400)
        self.store.record.assert_not_awaited()

    async def test_database_failure_returns_retryable_error(self):
        store = AsyncMock()
        store.record.side_effect = RuntimeError('sensitive database details')
        hook = ActivityHook(AsyncMock(), store, AsyncMock(return_value='alice'))
        send = AsyncMock()
        await hook({'type': 'http', 'path': '/user/activity', 'method': 'POST', 'headers': []},
                   AsyncMock(return_value={'type': 'http.request', 'body': json.dumps(EVENT).encode()}), send)
        self.assertEqual(send.call_args_list[0].args[0]['status'], 503)
        self.assertNotIn('sensitive', str(send.call_args_list))

    async def test_shutdown_closes_store(self):
        store, app = AsyncMock(), AsyncMock()
        await ActivityHook(app, store, AsyncMock())({'type': 'lifespan'}, AsyncMock(), AsyncMock())
        app.assert_awaited_once()
        store.close.assert_awaited_once()

    def test_rejects_credentials_in_metadata(self):
        with self.assertRaises(ValueError):
            validate_event({**EVENT, 'metadata': {'Cookie': 'secret'}})

    def test_rejects_invalid_event_type(self):
        for event_type in ('', 'Unknown', 'custom event', 'a' * 65, '../event'):
            with self.subTest(event_type=event_type), self.assertRaises(ValueError):
                validate_event({**EVENT, 'event_type': event_type})


if __name__ == '__main__':
    unittest.main()
