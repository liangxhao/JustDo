"""Shared service factory and explicit first-deployment database initialization."""

import asyncio
import json
import logging.config
import os
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from register import build_app, configure_auth, configured_hooks, initialize_hooks

LOG = logging.getLogger('litellm.deployment')


def configure_database(settings, environ):
    """Apply Prisma pool settings before LiteLLM loads its database configuration."""
    parameters = {}
    for setting, parameter, default in (
        ('database_connection_pool_limit', 'connection_limit', 4),
        ('database_connection_timeout', 'pool_timeout', 30),
    ):
        value = settings.get(setting, default)
        if type(value) is not int or value <= 0:
            raise ValueError(f'{setting} must be a positive integer')
        parameters[parameter] = str(value)

    if settings.get('database_url') != 'os.environ/DATABASE_URL':
        raise ValueError('Configure database_url as os.environ/DATABASE_URL')

    try:
        url = urlsplit(environ.get('DATABASE_URL', ''))
        if url.scheme not in {'postgres', 'postgresql'} or not url.hostname or url.fragment:
            raise ValueError()
        query = [(key, value) for key, value in parse_qsl(url.query, keep_blank_values=True)
                 if key not in parameters]
        query.extend(parameters.items())
        updated = urlunsplit(url._replace(query=urlencode(query)))
    except ValueError:
        raise ValueError('DATABASE_URL must be a valid PostgreSQL URI') from None

    # The activity pool uses a separate asyncpg DSN, without Prisma-only options.
    environ['DATABASE_URL'] = updated


def create_app():
    import yaml

    with open(os.environ['CONFIG_FILE_PATH'], encoding='utf-8') as source:
        config = yaml.safe_load(source)

    settings = config.get('general_settings', {})
    if settings.get('disable_prisma_schema_update') is not True:
        raise ValueError('Disable automatic Prisma schema updates')

    hooks = configured_hooks(os.environ)
    configure_database(settings, os.environ)
    os.environ['DISABLE_SCHEMA_UPDATE'] = 'true'
    from litellm.proxy.proxy_server import app

    configure_auth(settings, os.environ)
    wrapped = build_app(app, os.environ)
    LOG.info('Worker configured hooks=%s database_pool_limit=%s database_pool_timeout_seconds=%s',
             ','.join(hooks), settings.get('database_connection_pool_limit', 4),
             settings.get('database_connection_timeout', 30))
    return wrapped


async def initialize_extensions():
    import asyncpg

    connection = await asyncpg.connect(os.environ['LITELLM_ACTIVITY_DATABASE_URL'])
    try:
        async with connection.transaction():
            await initialize_hooks(connection, os.environ)
    finally:
        await connection.close()


def initialize_database():
    hooks = configured_hooks(os.environ)
    LOG.info('Database initialization started')
    from litellm.proxy.db.prisma_client import PrismaManager

    if not PrismaManager.setup_database(use_migrate=True, use_v2_resolver=True):
        raise SystemExit('LiteLLM database migration failed')

    LOG.info('Native database migration complete; initializing hooks=%s', ','.join(hooks))
    asyncio.run(initialize_extensions())
    LOG.info('Database initialization complete')


if __name__ == '__main__':
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['init'])
    parser.parse_args()
    with (Path(__file__).resolve().parent / 'logging.json').open(encoding='utf-8') as source:
        logging.config.dictConfig(json.load(source))
    initialize_database()
