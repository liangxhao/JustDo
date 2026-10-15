"""Add missing deployment fields and the default Team without native migrations."""

import argparse
import asyncio
import json
import os
from pathlib import Path

from hooks.jwt_auth import initialize as initialize_team

ROOT = Path(__file__).resolve().parent


class UpgradeError(ValueError):
    """A deployment problem whose message contains no credentials."""


def load_environment(env_file=None, inherited=None):
    environment = dict(os.environ if inherited is None else inherited)
    if env_file is not None:
        from dotenv import dotenv_values

        if not env_file.is_file():
            raise UpgradeError('The requested env file does not exist.')
        environment.update({key: value for key, value in dotenv_values(
            env_file, interpolate=False, encoding='utf-8').items() if value is not None})
    return environment


async def require_table(connection, name):
    if not await connection.fetchval('SELECT to_regclass($1)::text', f'public."{name}"'):
        raise UpgradeError(
            f'public.{name} is missing. Complete the native LiteLLM migration first.')


def report_team(team):
    metadata = team['metadata']
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except ValueError:
            metadata = None
    metadata = metadata if isinstance(metadata, dict) else {}
    if metadata.get('jwt_managed') is not True:
        print('[DatabaseUpgrade] CHECK: add boolean jwt_managed=true to the Team in the UI.')
    if metadata.get('legacy_clients') is True:
        print('[DatabaseUpgrade] CHECK: the default Team is a legacy Team; select a separate managed Team.')
    if team['blocked'] is not False:
        print('[DatabaseUpgrade] CHECK: the default Team is blocked; review its intended access.')
    if not team['models']:
        print('[DatabaseUpgrade] CHECK: select allowed models for the default Team in the UI.')


async def update(connection, environment, check=False):
    activity = 'activity' in {
        name.strip() for name in environment.get('LITELLM_HOOKS', 'activity').split(',')}
    team_id = environment.get('LITELLM_DEFAULT_TEAM_ID', '').strip()

    async with connection.transaction(readonly=check):
        await connection.execute(
            "SET LOCAL search_path = public; SET LOCAL lock_timeout = '3s'; "
            "SET LOCAL statement_timeout = '10s';")

        # Inspect every selected item before issuing any DDL or INSERT.
        missing_metadata = False
        if activity:
            await require_table(connection, 'LiteLLM_EndUserTable')
            column_type = await connection.fetchval(
                "SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' "
                "AND table_name = 'LiteLLM_EndUserTable' AND column_name = 'metadata'")
            if column_type not in (None, 'jsonb'):
                raise UpgradeError('EndUser metadata exists but is not jsonb; no changes were applied.')
            missing_metadata = column_type is None
            print('[DatabaseUpgrade] EndUser metadata: ' + (
                'add missing jsonb column.' if missing_metadata else 'already present; preserve it.'))
        else:
            print('[DatabaseUpgrade] Activity is disabled; skip the metadata column.')

        team = None
        if team_id:
            await require_table(connection, 'LiteLLM_TeamTable')
            team = await connection.fetchrow(
                'SELECT metadata, models, blocked FROM public."LiteLLM_TeamTable" WHERE team_id = $1',
                team_id)
            print('[DatabaseUpgrade] Default Team: ' + (
                'create if missing.' if team is None else 'already present; preserve all settings.'))
        else:
            print('[DatabaseUpgrade] Default Team ID is empty; skip creation and automatic enrollment.')

        if not check:
            if missing_metadata:
                await connection.execute((ROOT / 'hooks/activity/schema.sql').read_text(encoding='utf-8'))
            if team_id and team is None:
                await initialize_team(connection, environment)
                team = await connection.fetchrow(
                    'SELECT metadata, models, blocked FROM public."LiteLLM_TeamTable" WHERE team_id = $1',
                    team_id)
                if team is None:
                    raise UpgradeError('The default Team could not be created; changes were rolled back.')

    # Report completion only after a successful transaction commit.
    print('[DatabaseUpgrade] ' + ('Read-only check complete; no changes applied.' if check else
                                 'Update complete; existing records and Team settings preserved.'))
    if team is not None:
        report_team(team)
    elif team_id:
        print('[DatabaseUpgrade] CHECK: configure the new Team model list after applying the update.')
    print('[DatabaseUpgrade] CHECK: review existing user memberships in the UI; they are not changed here.')


async def run(environment, check=False):
    import asyncpg

    dsn = environment.get('LITELLM_ACTIVITY_DATABASE_URL', '').strip()
    if not dsn:
        raise UpgradeError('Set LITELLM_ACTIVITY_DATABASE_URL to the existing PostgreSQL database.')
    connection = await asyncpg.connect(dsn, timeout=10, command_timeout=15)
    try:
        await update(connection, environment, check)
    finally:
        await connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='Deployment .env file; overrides inherited variables.')
    parser.add_argument('--check', action='store_true', help='Read-only inspection without applying changes.')
    args = parser.parse_args(argv)
    try:
        asyncio.run(run(load_environment(args.env_file), args.check))
    except UpgradeError as error:
        parser.exit(1, f'[DatabaseUpgrade] {error}\n')
    except Exception:
        # Driver and dotenv errors can contain DSNs or file contents.
        parser.exit(1, '[DatabaseUpgrade] Update failed. Keep the service stopped and check the env file, '
                    'database connection, permissions and native schema. No native migrations were run; '
                    'database changes in this script are transactional.\n')


if __name__ == '__main__':
    main()
