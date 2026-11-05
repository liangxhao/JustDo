"""Real Team membership is independent of LiteLLM's optional member policy row."""

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import litellm
import pytest
from fastapi import Request
from litellm.caching.in_memory_cache import InMemoryCache
from litellm.models.team import LiteLLM_TeamTable, Member
from litellm.proxy._types import LiteLLM_TeamMembership, LiteLLM_UserTable, ProxyException, UserAPIKeyAuth
from litellm.proxy.auth import auth_checks
from litellm.proxy.common_utils.user_api_key_cache import UserApiKeyCache
from litellm.proxy.management_helpers.utils import add_new_member

from hooks.jwt_auth import handler
from hooks.jwt_auth.errors import JwtAuthError


@pytest.fixture
def access_context(monkeypatch):
    from litellm.proxy import proxy_server

    user = LiteLLM_UserTable(user_id='member-a', teams=['team-a'], user_email='member@example.test')
    # This cached Team predates enrollment. Admission must read the fresh roster.
    team = LiteLLM_TeamTable(
        team_id='team-a', members_with_roles=[], models=['chat-a'],
        metadata={'jwt_managed': True}, rpm_limit=20, tpm_limit=1000,
    )
    db = SimpleNamespace(
        query_raw=AsyncMock(return_value=[{'members_with_roles': [
            {'user_id': 'member-a', 'role': 'user'},
        ]}]),
        litellm_teammembership=SimpleNamespace(
            find_unique=AsyncMock(return_value=None), create=AsyncMock(),
        ),
        litellm_usertable=SimpleNamespace(
            upsert=AsyncMock(return_value=user), update_many=AsyncMock(return_value=1),
        ),
    )
    prisma = SimpleNamespace(db=db)
    cache = UserApiKeyCache(in_memory_cache=InMemoryCache())
    monkeypatch.setattr(proxy_server, 'prisma_client', prisma)
    monkeypatch.setattr(proxy_server, 'user_api_key_cache', cache)
    monkeypatch.setattr(auth_checks, 'get_user_object', AsyncMock(return_value=user))
    monkeypatch.setattr(auth_checks, 'get_team_object', AsyncMock(return_value=team))
    monkeypatch.setattr(handler, 'decode_and_validate_token', AsyncMock(return_value=(
        {'sub': 'member-a', 'jti': 'test-id'}, 'member-a', int(time.time()) + 300,
    )))
    monkeypatch.delenv('LITELLM_DEFAULT_TEAM_ID', raising=False)
    return SimpleNamespace(user=user, team=team, db=db, prisma=prisma, cache=cache)


async def authenticate():
    return await handler.user_api_key_auth(
        Request({'type': 'http', 'method': 'GET', 'path': '/v1/models', 'headers': []}),
        'Bearer header.payload.signature',
    )


@pytest.mark.asyncio
async def test_native_web_member_without_budget_can_authenticate(access_context):
    context = access_context
    _, policy = await add_new_member(
        new_member=Member(user_id='member-a', role='user'), max_budget_in_team=None,
        prisma_client=context.prisma, team_id='team-a',
        user_api_key_dict=UserAPIKeyAuth(user_id='admin'), litellm_proxy_admin_name='admin',
    )
    assert policy is None

    result = await authenticate()

    assert result.user_id == 'member-a'
    assert result.team_id == 'team-a'
    assert result.team_models == ['chat-a']
    assert result.team_rpm_limit == 20
    assert result.team_tpm_limit == 1000
    assert result.team_member_spend == 0
    assert result.team_member_rpm_limit is None
    assert result.team_member_tpm_limit is None
    assert context.team.members_with_roles == []
    context.db.query_raw.assert_awaited_once()
    context.db.litellm_usertable.upsert.assert_awaited_once()
    context.db.litellm_usertable.update_many.assert_awaited_once()
    context.db.litellm_teammembership.create.assert_not_awaited()


@pytest.mark.asyncio
async def test_first_automatic_enrollment_uses_the_fresh_roster(access_context, monkeypatch):
    context = access_context
    monkeypatch.setenv('LITELLM_DEFAULT_TEAM_ID', 'team-a')
    monkeypatch.setattr(auth_checks, 'get_user_object', AsyncMock(side_effect=ValueError('missing user')))
    enroll = AsyncMock()
    monkeypatch.setattr(handler, 'provision_first_login', enroll)
    context.db.litellm_usertable.find_unique = AsyncMock(return_value=context.user)
    policy = LiteLLM_TeamMembership(user_id='member-a', team_id='team-a')
    context.db.litellm_teammembership.find_unique.return_value = SimpleNamespace(dict=policy.model_dump)

    result = await authenticate()

    assert result.user_id == 'member-a'
    assert context.team.members_with_roles == []
    enroll.assert_awaited_once_with(context.db, 'member-a', 'team-a')
    context.db.query_raw.assert_awaited_once()


@pytest.mark.asyncio
async def test_removed_member_is_denied_even_with_a_cached_roster_and_old_policy(access_context):
    context = access_context
    context.team.members_with_roles = [Member(user_id='member-a', role='user')]
    context.db.query_raw.return_value = [{'members_with_roles': []}]
    context.db.litellm_teammembership.find_unique.return_value = LiteLLM_TeamMembership(
        user_id='member-a', team_id='team-a',
    )

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2003'
    context.db.litellm_teammembership.find_unique.assert_not_awaited()


@pytest.mark.asyncio
async def test_matching_email_does_not_substitute_for_exact_member_id(access_context):
    access_context.db.query_raw.return_value = [{'members_with_roles': [
        {'user_id': 'another-member', 'user_email': 'member@example.test', 'role': 'user'},
    ]}]

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2003'


@pytest.mark.asyncio
async def test_roster_entry_cannot_restore_a_removed_user_team(access_context):
    access_context.user.teams = []

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2002'
    access_context.db.query_raw.assert_not_awaited()


@pytest.mark.asyncio
async def test_existing_member_policy_keeps_limits_and_native_model_budget_checks(access_context, monkeypatch):
    policy = LiteLLM_TeamMembership.model_validate({
        'user_id': 'member-a', 'team_id': 'team-a', 'spend': 6, 'budget_id': 'policy-a',
        'litellm_budget_table': {
            'budget_id': 'policy-a', 'max_budget': 5, 'rpm_limit': 3,
            'tpm_limit': 100, 'allowed_models': ['chat-a'],
        },
    })
    access_context.team.models = ['chat-a', 'chat-b']
    access_context.db.litellm_teammembership.find_unique.return_value = SimpleNamespace(dict=policy.model_dump)

    result = await authenticate()

    assert result.team_member_spend == 6
    assert result.team_member_rpm_limit == 3
    assert result.team_member_tpm_limit == 100
    # A second DB read must not bypass the member's limits.
    access_context.db.litellm_teammembership.find_unique.side_effect = RuntimeError('unexpected second policy read')
    with pytest.raises(ProxyException, match='not allowed'):
        await auth_checks._check_team_member_model_access(
            model='chat-b', team_object=access_context.team, valid_token=result,
            llm_router=None, prisma_client=access_context.prisma,
            user_api_key_cache=access_context.cache, proxy_logging_obj=None,
        )
    from litellm.proxy import proxy_server
    monkeypatch.setattr(proxy_server, 'get_current_spend', AsyncMock(return_value=6))
    with pytest.raises(litellm.BudgetExceededError):
        await auth_checks._check_team_member_budget(
            team_object=access_context.team, user_object=access_context.user, valid_token=result,
            prisma_client=access_context.prisma, user_api_key_cache=access_context.cache, proxy_logging_obj=None,
        )
    access_context.db.litellm_teammembership.find_unique.assert_awaited_once()


@pytest.mark.asyncio
async def test_no_policy_still_obeys_team_model_and_blocked_checks(access_context):
    result = await authenticate()
    with pytest.raises(ProxyException, match='only access models'):
        await auth_checks.can_team_access_model('outside-model', access_context.team, None)
    assert result.team_models == ['chat-a']
    access_context.team.blocked = True
    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()
    assert rejected.value.to_dict()['code'] == 'AUTH-2005'


@pytest.mark.asyncio
async def test_no_personal_policy_still_obeys_native_team_default_budget(access_context, monkeypatch):
    from litellm.proxy import proxy_server

    access_context.team.metadata['team_member_budget_id'] = 'default-budget'
    monkeypatch.setattr(auth_checks, 'get_team_member_default_budget', AsyncMock(
        return_value=SimpleNamespace(max_budget=5),
    ))
    monkeypatch.setattr(proxy_server, 'get_current_spend', AsyncMock(return_value=6))

    result = await authenticate()

    with pytest.raises(litellm.BudgetExceededError):
        await auth_checks._check_team_member_budget(
            team_object=access_context.team, user_object=access_context.user, valid_token=result,
            prisma_client=access_context.prisma, user_api_key_cache=access_context.cache,
            proxy_logging_obj=None,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['database', 'malformed-roster'])
async def test_roster_read_failure_is_unavailable_instead_of_missing_membership(access_context, failure, caplog):
    if failure == 'database':
        access_context.db.query_raw.side_effect = RuntimeError('private-db-connection')
    else:
        access_context.db.query_raw.return_value = [{'members_with_roles': 'private-invalid-json'}]

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2502'
    assert rejected.value.details.status == 503
    assert 'private-' not in str(rejected.value.to_dict()) + caplog.text
    access_context.db.litellm_teammembership.find_unique.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['database', 'invalid-row', 'wrong-identity', 'missing-budget', 'wrong-budget'])
async def test_unreadable_policy_never_falls_back_to_unrestricted_access(access_context, failure, caplog):
    table = access_context.db.litellm_teammembership
    if failure == 'database':
        table.find_unique.side_effect = RuntimeError('private-policy-connection')
    else:
        value = {'user_id': 'member-a', 'team_id': 'team-a', 'spend': 1}
        if failure == 'invalid-row':
            value['spend'] = 'private-invalid-number'
        elif failure == 'wrong-identity':
            value['user_id'] = 'another-member'
        else:
            value['budget_id'] = 'expected-policy'
            if failure == 'wrong-budget':
                value['litellm_budget_table'] = {'budget_id': 'another-policy'}
        table.find_unique.return_value = SimpleNamespace(dict=lambda: value)

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2503'
    assert rejected.value.details.status == 503
    assert 'private-' not in str(rejected.value.to_dict()) + caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', ['write-error', 'silent-write-failure'])
async def test_policy_cache_failure_does_not_admit_a_principal(access_context, monkeypatch, failure):
    policy = LiteLLM_TeamMembership(user_id='member-a', team_id='team-a')
    access_context.db.litellm_teammembership.find_unique.return_value = SimpleNamespace(dict=policy.model_dump)
    write = AsyncMock()
    if failure == 'write-error':
        write.side_effect = RuntimeError('private-cache-connection')
    monkeypatch.setattr(access_context.cache, 'async_set_cache', write)

    with pytest.raises(JwtAuthError) as rejected:
        await authenticate()

    assert rejected.value.to_dict()['code'] == 'AUTH-2503'
    assert rejected.value.details.status == 503
