"""Activity persistence; connections are opened lazily per worker."""
import asyncio
import json
from datetime import timezone
from urllib.parse import parse_qs, urlsplit

from .events import merge_activity


def validate_database_url(dsn):
    """Reject Prisma-only options without ever including credentials in errors."""
    try:
        parsed = urlsplit(dsn)
        valid = parsed.scheme in ('postgres', 'postgresql') and bool(parsed.hostname)
        query = parse_qs(parsed.query, keep_blank_values=True)
        prisma_options = {
            'schema', 'connection_limit', 'pool_timeout', 'connect_timeout',
            'socket_timeout', 'pgbouncer', 'statement_cache_size',
            'sslaccept', 'sslidentity', 'sslpassword',
        }
        valid = valid and not (query.keys() & prisma_options)
    except (TypeError, ValueError):
        valid = False

    if not valid:
        raise ValueError(
            'LITELLM_ACTIVITY_DATABASE_URL must be a PostgreSQL URI without '
            'Prisma-specific options; configure schema using PostgreSQL search_path'
        )
    return dsn


class PostgresStore:
    def __init__(self, dsn):
        self.dsn = validate_database_url(dsn)
        self.pool = None
        self.lock = asyncio.Lock()

    async def record(self, event):
        if self.pool is None:
            async with self.lock:
                if self.pool is None:
                    import asyncpg

                    self.pool = await asyncpg.create_pool(
                        self.dsn,
                        min_size=0,
                        max_size=4,
                        timeout=3,
                        command_timeout=3,
                    )
        async with self.pool.acquire(timeout=3) as connection:
            async with connection.transaction():
                row = await connection.fetchrow(
                    'SELECT metadata FROM "LiteLLM_UserTable" '
                    'WHERE user_id=$1 FOR UPDATE',
                    event[1],
                )
                if row is None:
                    raise LookupError('User does not exist')
                previous = json.loads(row['metadata']) if row['metadata'] else {}
                now = await connection.fetchval('SELECT clock_timestamp()')
                merged = merge_activity(previous, event, now.astimezone(timezone.utc))
                await connection.execute(
                    'UPDATE "LiteLLM_UserTable" SET metadata=$2::jsonb WHERE user_id=$1',
                    event[1],
                    json.dumps(merged),
                )

    async def close(self):
        if self.pool is not None:
            try:
                async with asyncio.timeout(5):
                    await self.pool.close()
            except TimeoutError:
                self.pool.terminate()
