from __future__ import annotations

import time
from types import SimpleNamespace

import custom_auth
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, Request
from litellm.models.team import LiteLLM_TeamTable
from litellm.proxy._types import ProxyException
from litellm.proxy.auth.auth_checks import can_team_access_model
from litellm.proxy.auth.route_checks import RouteChecks


def settings(**overrides) -> custom_auth.JwtSettings:
    values = {
        "issuer": "https://login.example.test",
        "audience": "justdo-litellm",
        "jwks_url": "https://login.example.test/.well-known/jwks.json",
        "algorithms": ("RS256",),
        "max_lifetime_seconds": 300,
        "clock_skew_seconds": 30,
    }
    values.update(overrides)
    return custom_auth.JwtSettings(**values)


def request_with_headers(**headers: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/v1/models",
            "headers": [
                (name.lower().encode("latin-1"), value.encode("latin-1"))
                for name, value in headers.items()
            ],
        }
    )


@pytest.fixture(autouse=True)
def clear_settings_cache():
    custom_auth.load_settings.cache_clear()
    custom_auth._get_jwks_client.cache_clear()
    yield
    custom_auth.load_settings.cache_clear()
    custom_auth._get_jwks_client.cache_clear()


def test_load_settings_rejects_symmetric_algorithms_and_remote_http(monkeypatch):
    monkeypatch.setenv("JUSTDO_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("JUSTDO_JWT_AUDIENCE", "justdo-litellm")
    monkeypatch.setenv("JUSTDO_JWT_JWKS_URL", "https://login.example.test/jwks")
    monkeypatch.setenv("JUSTDO_JWT_ALGORITHMS", "HS256")

    with pytest.raises(RuntimeError, match="symmetric"):
        custom_auth.load_settings()

    custom_auth.load_settings.cache_clear()
    monkeypatch.setenv("JUSTDO_JWT_ALGORITHMS", "RS256")
    monkeypatch.setenv("JUSTDO_JWT_JWKS_URL", "http://login.example.test/jwks")
    with pytest.raises(RuntimeError, match="must use HTTPS"):
        custom_auth.load_settings()


def test_load_settings_never_allows_jwt_lifetimes_above_five_minutes(monkeypatch):
    monkeypatch.setenv("JUSTDO_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("JUSTDO_JWT_AUDIENCE", "justdo-litellm")
    monkeypatch.setenv("JUSTDO_JWT_JWKS_URL", "https://login.example.test/jwks")
    monkeypatch.setenv("JUSTDO_JWT_MAX_LIFETIME_SECONDS", "301")

    with pytest.raises(RuntimeError, match="between 30 and 300"):
        custom_auth.load_settings()


def test_validate_claims_limits_token_lifetime_and_requires_jti():
    now = 2_000_000_000
    claims = {"sub": "user-001", "jti": "token-1", "iat": now, "exp": now + 300}

    assert custom_auth.validate_claims(claims, settings(), now) == (
        "user-001",
        now + 300,
    )

    with pytest.raises(ProxyException, match="lifetime"):
        custom_auth.validate_claims({**claims, "exp": now + 301}, settings(), now)
    with pytest.raises(ProxyException, match="lifetime"):
        custom_auth.validate_claims(
            {**claims, "iat": now + 30, "exp": now + 330}, settings(), now
        )
    with pytest.raises(ProxyException, match="expired"):
        custom_auth.validate_claims(
            {**claims, "iat": now - 300, "exp": now}, settings(), now
        )
    with pytest.raises(ProxyException, match="jti"):
        custom_auth.validate_claims({**claims, "jti": ""}, settings(), now)


@pytest.mark.asyncio
async def test_decode_and_validate_token_verifies_signature_issuer_and_audience(
    monkeypatch,
):
    now = int(time.time())
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2_048)
    token = jwt.encode(
        {
            "iss": "https://login.example.test",
            "aud": "justdo-litellm",
            "sub": "user-001",
            "iat": now,
            "exp": now + 300,
            "jti": "token-1",
        },
        private_key,
        algorithm="RS256",
        headers={"kid": "login-key-1"},
    )
    monkeypatch.setattr(custom_auth, "load_settings", lambda: settings())
    monkeypatch.setattr(
        custom_auth,
        "_get_jwks_client",
        lambda: SimpleNamespace(
            get_signing_key_from_jwt=lambda _token: SimpleNamespace(
                key=private_key.public_key()
            )
        ),
    )

    claims, user_id, expires_at = await custom_auth.decode_and_validate_token(token)

    assert claims["jti"] == "token-1"
    assert user_id == "user-001"
    assert expires_at == now + 300


@pytest.mark.asyncio
async def test_decode_and_validate_token_requires_a_key_id(monkeypatch):
    now = int(time.time())
    private_key = rsa.generate_private_key(public_exponent=65_537, key_size=2_048)
    token = jwt.encode(
        {
            "iss": "https://login.example.test",
            "aud": "justdo-litellm",
            "sub": "user-001",
            "iat": now,
            "exp": now + 300,
            "jti": "token-1",
        },
        private_key,
        algorithm="RS256",
    )
    monkeypatch.setattr(custom_auth, "load_settings", lambda: settings())
    jwks_client = SimpleNamespace(get_signing_key_from_jwt=lambda _token: None)
    monkeypatch.setattr(custom_auth, "_get_jwks_client", lambda: jwks_client)

    with pytest.raises(ProxyException, match="JWT validation failed"):
        await custom_auth.decode_and_validate_token(token)


@pytest.mark.asyncio
async def test_auth_rejects_account_header_that_does_not_match_jwt_subject(monkeypatch):
    token = "header.payload.signature"

    async def decode(_token):
        return ({"sub": "user-001"}, "user-001", int(time.time()) + 300)

    monkeypatch.setattr(custom_auth, "decode_and_validate_token", decode)

    with pytest.raises(ProxyException, match="does not match"):
        await custom_auth.user_api_key_auth(
            request_with_headers(
                **{
                    "X-JustDo-JWT": token,
                    "X-User-Account": "user-002",
                }
            ),
            "Bearer stolen-legacy-key",
        )


@pytest.mark.asyncio
async def test_auth_projects_persistent_team_policy_without_a_virtual_key(monkeypatch):
    token = "header.payload.signature"
    expires_at = int(time.time()) + 300

    async def decode(_token):
        return ({"sub": "user-001", "jti": "token-1"}, "user-001", expires_at)

    membership = SimpleNamespace(
        spend=1.5,
        safe_get_team_member_rpm_limit=lambda: 12,
        safe_get_team_member_tpm_limit=lambda: 34,
    )
    access = custom_auth.ResolvedAccess(
        user=SimpleNamespace(
            user_email="user@example.test",
            spend=2.5,
            max_budget=10,
            tpm_limit=100,
            rpm_limit=20,
            model_max_budget={},
        ),
        team=SimpleNamespace(
            team_id="team-a",
            team_alias="A",
            spend=4.5,
            max_budget=20,
            soft_budget=None,
            tpm_limit=1_000,
            rpm_limit=200,
            models=["model-a"],
            blocked=False,
            metadata={"justdo_managed": True},
            object_permission_id=None,
        ),
        membership=membership,
    )

    async def resolve(_user_id):
        return access

    monkeypatch.setattr(custom_auth, "decode_and_validate_token", decode)
    monkeypatch.setattr(custom_auth, "resolve_managed_access", resolve)

    result = await custom_auth.user_api_key_auth(
        request_with_headers(
            **{
                "X-JustDo-JWT": token,
                "X-User-Account": "user-001",
            }
        ),
        "Bearer this-value-is-ignored",
    )

    assert result.api_key is None
    assert result.key_alias == "justdo-short-lived-jwt"
    assert result.user_id == "user-001"
    assert result.team_id == "team-a"
    assert result.team_models == ["model-a"]
    assert result.models == ["all-team-models"]
    assert result.allowed_routes == ["llm_api_routes", "/models", "/v1/models"]
    assert result.team_rpm_limit == 200
    assert result.team_member_rpm_limit == 12
    assert result.jwt_claims["jti"] == "token-1"
    assert "this-value-is-ignored" not in (result.token or "")
    assert RouteChecks.is_virtual_key_allowed_to_call_route("/models", result)
    assert RouteChecks.is_virtual_key_allowed_to_call_route("/v1/models", result)
    assert RouteChecks.is_virtual_key_allowed_to_call_route("/chat/completions", result)
    with pytest.raises(HTTPException, match="not allowed"):
        RouteChecks.is_virtual_key_allowed_to_call_route("/team/new", result)


@pytest.mark.asyncio
async def test_auth_accepts_authorization_jwt_for_memory_search(monkeypatch):
    token = "header.payload.signature"
    expires_at = int(time.time()) + 300

    async def decode(_token):
        return ({"sub": "user-001", "jti": "token-1"}, "user-001", expires_at)

    async def resolve(_user_id):
        return custom_auth.ResolvedAccess(
            user=SimpleNamespace(
                user_email=None,
                spend=0,
                max_budget=None,
                tpm_limit=None,
                rpm_limit=None,
                model_max_budget={},
            ),
            team=SimpleNamespace(
                team_id="team-a",
                team_alias="A",
                spend=0,
                max_budget=None,
                soft_budget=None,
                tpm_limit=None,
                rpm_limit=None,
                models=["embedding-a"],
                blocked=False,
                metadata={"justdo_managed": True},
                object_permission_id=None,
            ),
            membership=SimpleNamespace(
                spend=0,
                safe_get_team_member_rpm_limit=lambda: None,
                safe_get_team_member_tpm_limit=lambda: None,
            ),
        )

    monkeypatch.setattr(custom_auth, "decode_and_validate_token", decode)
    monkeypatch.setattr(custom_auth, "resolve_managed_access", resolve)

    result = await custom_auth.user_api_key_auth(
        request_with_headers(),
        f"Bearer {token}",
    )

    assert result.user_id == "user-001"
    assert result.end_user_id == "user-001"
    assert result.team_models == ["embedding-a"]


@pytest.mark.asyncio
async def test_auth_fails_closed_for_a_managed_team_without_explicit_models(
    monkeypatch,
):
    async def decode(_token):
        return (
            {"sub": "user-001", "jti": "token-1"},
            "user-001",
            int(time.time()) + 300,
        )

    async def resolve(_user_id):
        return custom_auth.ResolvedAccess(
            user=SimpleNamespace(
                user_email=None,
                spend=0,
                max_budget=None,
                tpm_limit=None,
                rpm_limit=None,
                model_max_budget={},
            ),
            team=SimpleNamespace(models=[]),
            membership=SimpleNamespace(),
        )

    monkeypatch.setattr(custom_auth, "decode_and_validate_token", decode)
    monkeypatch.setattr(custom_auth, "resolve_managed_access", resolve)

    with pytest.raises(ProxyException, match="explicit model list"):
        await custom_auth.user_api_key_auth(
            request_with_headers(
                **{
                    "X-JustDo-JWT": "header.payload.signature",
                    "X-User-Account": "user-001",
                }
            ),
            "Bearer justdo-jwt-auth",
        )


@pytest.mark.asyncio
async def test_projected_team_allowlist_rejects_a_model_from_another_group():
    team = LiteLLM_TeamTable(team_id="team-a", models=["model-a"])

    assert await can_team_access_model("model-a", team, None) is True
    with pytest.raises(ProxyException, match="only access models"):
        await can_team_access_model("model-b", team, None)
