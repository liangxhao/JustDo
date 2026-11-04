"""Optional JWT activity smoke test against an existing dedicated test user.

Set LITELLM_SMOKE_JWT and LITELLM_SMOKE_USER_ID for that provisioned user.
The test leaves one startup activity event and never creates/deletes accounts.
"""
import asyncio
import json
import os
import urllib.request
import urllib.error
from uuid import uuid4

import asyncpg


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


async def main():
    token = os.environ.get('LITELLM_SMOKE_JWT', '')
    user_id = os.environ.get('LITELLM_SMOKE_USER_ID', '')
    if not token or not user_id:
        raise SystemExit('Configure a JWT and existing dedicated user for the activity smoke test.')
    base_url = os.getenv('LITELLM_SMOKE_BASE_URL', 'http://127.0.0.1:4000').rstrip('/')
    db = await asyncpg.connect(os.environ['LITELLM_ACTIVITY_DATABASE_URL'])
    opener = urllib.request.build_opener(NoRedirect())
    try:
        before = await db.fetchrow('SELECT metadata, user_alias FROM "LiteLLM_UserTable" WHERE user_id=$1', user_id)
        if before is None:
            raise SystemExit('The dedicated smoke-test user must already exist.')
        before_metadata = json.loads(before['metadata'] or '{}')
        event = {'event_id': str(uuid4()), 'user_id': user_id, 'event_type': 'startup',
                 'metadata': {'productName': 'SmokeTest', 'version': '1'}}

        def post(credential):
            request = urllib.request.Request(base_url + '/user/activity',
                data=json.dumps(event).encode(), headers={'Authorization': 'Bearer ' + credential,
                                                        'Content-Type': 'application/json'})
            try:
                with opener.open(request, timeout=10) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code

        assert await asyncio.to_thread(post, 'invalid') == 401
        assert await asyncio.to_thread(post, token) == 200
        first = json.loads(await db.fetchval('SELECT metadata FROM "LiteLLM_UserTable" WHERE user_id=$1', user_id))
        assert await asyncio.to_thread(post, token) == 200
        row = await db.fetchrow('SELECT metadata, user_alias FROM "LiteLLM_UserTable" WHERE user_id=$1', user_id)
        metadata = json.loads(row['metadata'])
        activity = metadata['user_activity']
        assert activity['recent_event_ids'].count(event['event_id']) == 1
        assert activity['last_started_at'] == first['user_activity']['last_started_at']
        assert {day: value['start_count'] for day, value in activity['days'].items()} == {
            day: value['start_count'] for day, value in first['user_activity']['days'].items()}
        assert {key: value for key, value in metadata.items() if key != 'user_activity'} == {
            key: value for key, value in before_metadata.items() if key != 'user_activity'}
        assert row['user_alias'] == before['user_alias']
        print('JWT authentication, metadata preservation and duplicate suppression: PASS')
    finally:
        await db.close()


if __name__ == '__main__':
    asyncio.run(main())
