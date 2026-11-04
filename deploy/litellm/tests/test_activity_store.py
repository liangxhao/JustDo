import json
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from hooks.activity.events import validate_event
from hooks.activity.store import PostgresStore


def fixture(metadata):
    connection = MagicMock()
    connection.transaction.return_value.__aenter__ = AsyncMock()
    connection.transaction.return_value.__aexit__ = AsyncMock(return_value=False)
    connection.fetchrow = AsyncMock(return_value={'metadata': json.dumps(metadata)} if metadata is not None else None)
    connection.fetchval = AsyncMock(return_value=datetime(2026, 11, 4, tzinfo=timezone.utc))
    connection.execute = AsyncMock()
    lease = MagicMock()
    lease.__aenter__ = AsyncMock(return_value=connection)
    lease.__aexit__ = AsyncMock(return_value=False)
    store = PostgresStore('postgresql://localhost/test')
    store.pool = SimpleNamespace(acquire=lambda **kwargs: lease)
    return store, connection


EVENT = validate_event({
    'event_id': '822f78cc-bd26-4e13-a42a-b45060a330da',
    'user_id': 'alice', 'event_type': 'startup',
    'metadata': {'productName': 'Example', 'version': '2'},
})


@pytest.mark.asyncio
async def test_existing_user_metadata_is_preserved_without_other_account_writes():
    store, connection = fixture({'other': True, 'jwt_auto_provisioned': True})
    await store.record(EVENT)
    query, user_id, supplied = connection.execute.call_args.args
    assert query == 'UPDATE "LiteLLM_UserTable" SET metadata=$2::jsonb WHERE user_id=$1'
    assert user_id == 'alice'
    result = json.loads(supplied)
    assert result['other'] is True
    assert result['jwt_auto_provisioned'] is True
    assert result['user_activity']['metadata'] == {'productName': 'Example', 'version': '2'}
    assert result['user_activity']['days']['2026-11-04']['start_count'] == 1
    connection.execute.assert_awaited_once()
    connection.transaction.return_value.__aexit__.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_user_is_never_created_or_updated_by_activity():
    store, connection = fixture(None)
    with pytest.raises(LookupError, match='User does not exist'):
        await store.record(EVENT)
    connection.execute.assert_not_awaited()
    connection.fetchval.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_object_stored_metadata_cannot_be_overwritten():
    store, connection = fixture(['existing', 'metadata'])
    with pytest.raises(ValueError, match='Stored user metadata is not an object'):
        await store.record(EVENT)
    connection.execute.assert_not_awaited()
