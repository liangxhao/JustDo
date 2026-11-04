import json
import os
import unittest
from uuid import uuid4
from hooks.activity.store import PostgresStore
from hooks.activity.events import validate_event


@unittest.skipUnless(os.getenv('LITELLM_TEST_DATABASE_URL'), 'No test database configured')
class DatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def test_later_hook_failure_rolls_back_default_team(self):
        import asyncpg
        from hooks.jwt_auth import initialize as initialize_team
        connection = await asyncpg.connect(os.environ['LITELLM_TEST_DATABASE_URL'])
        try:
            await connection.execute('CREATE TEMP TABLE "LiteLLM_TeamTable" ('
                'team_id text PRIMARY KEY, team_alias text, admins text[], members text[], '
                'members_with_roles jsonb, metadata jsonb, models text[])')
            with self.assertRaisesRegex(RuntimeError, 'Later hook failed'):
                async with connection.transaction():
                    await initialize_team(connection, {'LITELLM_DEFAULT_TEAM_ID': 'standard'})
                    raise RuntimeError('Later hook failed')
            self.assertEqual(await connection.fetchval('SELECT count(*) FROM "LiteLLM_TeamTable"'), 0)
        finally:
            await connection.close()

    async def test_default_team_init_preserves_live_admin_changes(self):
        import asyncpg
        from hooks.jwt_auth import initialize
        connection = await asyncpg.connect(os.environ['LITELLM_TEST_DATABASE_URL'])
        try:
            await connection.execute('CREATE TEMP TABLE "LiteLLM_TeamTable" ('
                'team_id text PRIMARY KEY, team_alias text, admins text[], members text[], '
                'members_with_roles jsonb, metadata jsonb, models text[], max_budget float, blocked boolean)')
            environment = {'LITELLM_DEFAULT_TEAM_ID': 'standard'}
            await initialize(connection, environment)
            first = await connection.fetchrow('SELECT * FROM "LiteLLM_TeamTable"')
            self.assertEqual(first['models'], [])
            self.assertEqual(json.loads(first['metadata']), {'jwt_managed': True})
            await connection.execute('UPDATE "LiteLLM_TeamTable" SET '
                "models=ARRAY['model-a'], members=ARRAY['alice'], max_budget=12, blocked=true")
            before = dict(await connection.fetchrow('SELECT * FROM "LiteLLM_TeamTable"'))
            await initialize(connection, environment)
            after = dict(await connection.fetchrow('SELECT * FROM "LiteLLM_TeamTable"'))
            self.assertEqual(after, before)
        finally:
            await connection.close()

    async def test_atomic_metadata_preservation_and_deduplication(self):
        import asyncpg
        store = PostgresStore(os.environ['LITELLM_TEST_DATABASE_URL'])
        # A dedicated connection keeps the temporary table scoped to this test.
        connection = await asyncpg.connect(store.dsn)
        class Lease:
            async def __aenter__(self):
                return connection
            async def __aexit__(self, *args):
                pass
        class Pool:
            def acquire(self, **kwargs):
                return Lease()
        store.pool = Pool()
        try:
            await connection.execute('CREATE TEMP TABLE "LiteLLM_UserTable" '
                                     '(user_id text PRIMARY KEY, metadata jsonb, user_alias text, spend float)')
            await connection.execute('INSERT INTO "LiteLLM_UserTable" (user_id, metadata, user_alias, spend) '
                                     'VALUES ($1, $2::jsonb, $3, $4)', 'test', '{"other":true}', 'Admin alias', 12.5)
            event = validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'startup'})
            await store.record(event)
            await store.record(event)
            row = await connection.fetchrow('SELECT * FROM "LiteLLM_UserTable"')
            result = json.loads(row['metadata'])
            self.assertTrue(result['other'])
            self.assertEqual(row['user_alias'], 'Admin alias')
            self.assertEqual(row['spend'], 12.5)
            day = next(iter(result['user_activity']['days'].values()))
            self.assertEqual(day['start_count'], 1)
            with self.assertRaises(LookupError):
                await store.record(validate_event({'event_id': str(uuid4()), 'user_id': 'missing', 'event_type': 'startup'}))
            self.assertEqual(await connection.fetchval('SELECT count(*) FROM "LiteLLM_UserTable"'), 1)
        finally:
            await connection.close()
