"""Incremental upgrades preserve existing records and never run native migrations."""

import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import upgrade


ENVIRONMENT = {
    'LITELLM_HOOKS': 'activity',
    'LITELLM_DEFAULT_TEAM_ID': 'standard',
    'LITELLM_ACTIVITY_DATABASE_URL': 'postgresql://user:test-only-password@localhost/models',
}
TEAM = {
    'metadata': json.dumps({'jwt_managed': True, 'other': 'preserve'}),
    'models': ['model-a'],
    'blocked': False,
}


def connection_fixture(column_type='jsonb', team=TEAM, missing_table=None):
    connection = Mock()
    transaction = AsyncMock()
    transaction.__aexit__.return_value = False
    connection.transaction.return_value = transaction
    connection.execute = AsyncMock()
    connection.fetchrow = AsyncMock(return_value=team)
    connection.close = AsyncMock()

    async def fetchval(sql, *args):
        if 'to_regclass' in sql:
            return None if args[0] == missing_table else args[0]
        return column_type

    connection.fetchval = AsyncMock(side_effect=fetchval)
    return connection, transaction


class UpgradeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.output = io.StringIO()
        self.redirect = redirect_stdout(self.output)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)

    async def test_check_is_read_only_and_does_not_add_missing_items(self):
        connection, _ = connection_fixture(column_type=None, team=None)
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            await upgrade.update(connection, ENVIRONMENT, check=True)
        connection.transaction.assert_called_once_with(readonly=True)
        create_team.assert_not_awaited()
        self.assertEqual(connection.execute.await_count, 1)
        self.assertTrue(connection.execute.await_args.args[0].startswith('SET LOCAL'))
        self.assertIn('Read-only check complete', self.output.getvalue())

    async def test_apply_adds_missing_column_and_delegates_insert_only_team_creation(self):
        connection, transaction = connection_fixture(column_type=None, team=None)
        connection.fetchrow.side_effect = [None, TEAM]
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            await upgrade.update(connection, ENVIRONMENT)
        create_team.assert_awaited_once_with(connection, ENVIRONMENT)
        schema = (upgrade.ROOT / 'hooks/activity/schema.sql').read_text(encoding='utf-8')
        connection.execute.assert_any_await(schema)
        transaction.__aexit__.assert_awaited_once_with(None, None, None)
        self.assertIn('Update complete', self.output.getvalue())

    async def test_repeated_update_preserves_existing_team_even_if_not_managed_or_blocked(self):
        existing = {'metadata': '{"other":true}', 'models': ['private-model'], 'blocked': True}
        before = dict(existing)
        connection, _ = connection_fixture(team=existing)
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            await upgrade.update(connection, ENVIRONMENT)
            await upgrade.update(connection, ENVIRONMENT)
        self.assertEqual(existing, before)
        create_team.assert_not_awaited()
        self.assertEqual(connection.execute.await_count, 2)
        self.assertTrue(all(call.args[0].startswith('SET LOCAL')
                            for call in connection.execute.await_args_list))
        self.assertIn('jwt_managed=true', self.output.getvalue())
        self.assertIn('Team is blocked', self.output.getvalue())

    async def test_existing_legacy_team_and_empty_model_list_are_reported_without_changes(self):
        connection, _ = connection_fixture(team={
            'metadata': '{"jwt_managed":true,"legacy_clients":true}',
            'models': [], 'blocked': False})
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            await upgrade.update(connection, ENVIRONMENT)
        create_team.assert_not_awaited()
        self.assertIn('legacy Team', self.output.getvalue())
        self.assertIn('select allowed models', self.output.getvalue())

    async def test_wrong_column_type_stops_before_any_persistent_write(self):
        connection, _ = connection_fixture(column_type='text', team=None)
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            with self.assertRaisesRegex(upgrade.UpgradeError, 'not jsonb'):
                await upgrade.update(connection, ENVIRONMENT)
        create_team.assert_not_awaited()
        self.assertEqual(connection.execute.await_count, 1)

    async def test_missing_native_team_table_prevents_column_addition(self):
        connection, _ = connection_fixture(
            column_type=None, missing_table='public."LiteLLM_TeamTable"')
        with self.assertRaisesRegex(upgrade.UpgradeError, 'native LiteLLM migration'):
            await upgrade.update(connection, ENVIRONMENT)
        self.assertEqual(connection.execute.await_count, 1)

    async def test_empty_team_id_does_not_create_or_assign_a_default_team(self):
        connection, _ = connection_fixture(column_type=None)
        with patch('upgrade.initialize_team', new_callable=AsyncMock) as create_team:
            await upgrade.update(connection, {**ENVIRONMENT, 'LITELLM_DEFAULT_TEAM_ID': ''})
        create_team.assert_not_awaited()
        connection.fetchrow.assert_not_awaited()
        self.assertIn('skip creation', self.output.getvalue())

    async def test_disabled_activity_does_not_require_end_user_table_or_change_schema(self):
        connection, _ = connection_fixture(missing_table='public."LiteLLM_EndUserTable"')
        await upgrade.update(connection, {**ENVIRONMENT, 'LITELLM_HOOKS': ''})
        self.assertEqual(connection.execute.await_count, 1)
        self.assertEqual(connection.fetchval.await_count, 1)
        self.assertIn('Activity is disabled', self.output.getvalue())

    async def test_team_creation_failure_rolls_back_transaction_and_closes_connection(self):
        connection, transaction = connection_fixture(column_type=None, team=None)
        failure = RuntimeError('test-only failure')
        driver = SimpleNamespace(connect=AsyncMock(return_value=connection))
        with patch.dict('sys.modules', {'asyncpg': driver}):
            with patch('upgrade.initialize_team', new_callable=AsyncMock, side_effect=failure):
                with self.assertRaises(RuntimeError):
                    await upgrade.run(ENVIRONMENT)
        self.assertEqual(transaction.__aexit__.await_args.args[:2], (RuntimeError, failure))
        connection.close.assert_awaited_once()
        self.assertNotIn('Update complete', self.output.getvalue())

    async def test_commit_failure_does_not_report_success(self):
        connection, transaction = connection_fixture()
        transaction.__aexit__.side_effect = RuntimeError('commit failed')
        with self.assertRaises(RuntimeError):
            await upgrade.update(connection, ENVIRONMENT)
        self.assertNotIn('Update complete', self.output.getvalue())


class CommandTests(unittest.TestCase):
    def test_env_file_preserves_literal_secrets_and_explicit_empty_team(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('LITELLM_DEFAULT_TEAM_ID=\nREDIS_PASSWORD=literal${DOLLAR}\n', encoding='utf-8')
            environment = upgrade.load_environment(path, {'LITELLM_DEFAULT_TEAM_ID': 'inherited'})
        self.assertEqual(environment['LITELLM_DEFAULT_TEAM_ID'], '')
        self.assertEqual(environment['REDIS_PASSWORD'], 'literal${DOLLAR}')

    def test_missing_env_file_is_not_silently_ignored(self):
        with TemporaryDirectory() as directory:
            with self.assertRaises(upgrade.UpgradeError):
                upgrade.load_environment(Path(directory) / 'missing.env', {})

    def test_missing_database_url_never_attempts_connection(self):
        driver = SimpleNamespace(connect=AsyncMock())
        with patch.dict('sys.modules', {'asyncpg': driver}):
            with self.assertRaisesRegex(upgrade.UpgradeError, 'LITELLM_ACTIVITY_DATABASE_URL'):
                asyncio.run(upgrade.run({}))
        driver.connect.assert_not_awaited()

    def test_driver_errors_never_expose_credentials_or_tracebacks(self):
        driver = SimpleNamespace(connect=AsyncMock(side_effect=ValueError('secret-dsn-and-password')))
        output = io.StringIO()
        with patch.dict('sys.modules', {'asyncpg': driver}):
            with patch.dict('os.environ', ENVIRONMENT, clear=True), redirect_stdout(io.StringIO()):
                with patch('sys.stderr', output), self.assertRaises(SystemExit) as error:
                    upgrade.main(['--check'])
        self.assertEqual(error.exception.code, 1)
        self.assertNotIn('secret-dsn-and-password', output.getvalue())
        self.assertNotIn('Traceback', output.getvalue())


if __name__ == '__main__':
    unittest.main()
