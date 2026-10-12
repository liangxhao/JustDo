from __future__ import annotations

import time
import json
from types import SimpleNamespace

from hooks.jwt_auth import handler as custom_auth
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
        "audience": "model-service",
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
def clear_settings_cache(monkeypatch):
    monkeypatch.delenv("LITELLM_JWT_ALLOW_HTTP_JWKS", raising=False)
    custom_auth.load_settings.cache_clear()
    custom_auth._get_jwks_client.cache_clear()
    yield
    custom_auth.load_settings.cache_clear()
    custom_auth._get_jwks_client.cache_clear()


def test_load_settings_rejects_symmetric_algorithms_and_remote_http(monkeypatch):
    monkeypatch.setenv("LITELLM_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("LITELLM_JWT_AUDIENCE", "model-service")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "https://login.example.test/jwks")
    monkeypatch.setenv("LITELLM_JWT_ALGORITHMS", "HS256")

    with pytest.raises(RuntimeError, match="symmetric"):
        custom_auth.load_settings()

    custom_auth.load_settings.cache_clear()
    monkeypatch.setenv("LITELLM_JWT_ALGORITHMS", "RS256")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "http://login.example.test/jwks")
    with pytest.raises(RuntimeError, match="must use HTTPS"):
        custom_auth.load_settings()


@pytest.mark.parametrize("enabled", ["1", "true", "yes", " TRUE ", "Yes"])
def test_load_settings_accepts_remote_http_jwks_when_explicitly_enabled(monkeypatch, enabled):
    monkeypatch.setenv("LITELLM_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("LITELLM_JWT_AUDIENCE", "model-service")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "http://login.example.test/jwks")
    monkeypatch.setenv("LITELLM_JWT_ALLOW_HTTP_JWKS", enabled)

    loaded = custom_auth.load_settings()

    assert loaded.jwks_url == "http://login.example.test/jwks"
    assert loaded.issuer == "https://login.example.test"
    assert loaded.algorithms == ("RS256",)


@pytest.mark.parametrize("disabled", ["", "0", "false", "no", "enabled"])
def test_load_settings_rejects_remote_http_without_an_enabled_opt_in(monkeypatch, disabled):
    monkeypatch.setenv("LITELLM_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("LITELLM_JWT_AUDIENCE", "model-service")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "http://login.example.test/jwks")
    monkeypatch.setenv("LITELLM_JWT_ALLOW_HTTP_JWKS", disabled)

    with pytest.raises(RuntimeError, match="LITELLM_JWT_ALLOW_HTTP_JWKS"):
        custom_auth.load_settings()


@pytest.mark.parametrize("hostname", ["127.0.0.1", "[::1]", "localhost"])
def test_load_settings_preserves_http_loopback_without_opt_in(monkeypatch, hostname):
    monkeypatch.setenv("LITELLM_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("LITELLM_JWT_AUDIENCE", "model-service")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", f"http://{hostname}/jwks")
    monkeypatch.setenv("LITELLM_JWT_ALLOW_HTTP_JWKS", "false")

    assert custom_auth.load_settings().jwks_url == f"http://{hostname}/jwks"


@pytest.mark.parametrize("url", ["ftp://login.example.test/jwks", "/jwks", "http:///jwks"])
def test_http_jwks_opt_in_still_requires_an_absolute_http_or_https_url(monkeypatch, url):
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", url)
    monkeypatch.setenv("LITELLM_JWT_ALLOW_HTTP_JWKS", "true")

    with pytest.raises(RuntimeError, match="absolute HTTP"):
        custom_auth.load_settings()


def test_http_jwks_opt_in_does_not_allow_symmetric_algorithms(monkeypatch):
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "http://login.example.test/jwks")
    monkeypatch.setenv("LITELLM_JWT_ALLOW_HTTP_JWKS", "true")
    monkeypatch.setenv("LITELLM_JWT_ALGORITHMS", "HS256")

    with pytest.raises(RuntimeError, match="symmetric"):
        custom_auth.load_settings()


def test_environment_settings_preserve_defaults_and_explicit_empty_values(monkeypatch):
    monkeypatch.delenv('LITELLM_JWT_AUDIENCE', raising=False)
    assert custom_auth._auth_env('LITELLM_JWT_AUDIENCE', 'default-audience') == 'default-audience'
    monkeypatch.setenv('LITELLM_JWT_AUDIENCE', 'new-audience')
    assert custom_auth._auth_env('LITELLM_JWT_AUDIENCE') == 'new-audience'
    monkeypatch.setenv('LITELLM_JWT_AUDIENCE', '')
    with pytest.raises(RuntimeError):
        custom_auth._required_env('LITELLM_JWT_AUDIENCE')
    monkeypatch.setenv('LITELLM_DEFAULT_TEAM_ID', '')
    assert custom_auth._auth_env('LITELLM_DEFAULT_TEAM_ID', 'default-team') == ''


def test_load_settings_never_allows_jwt_lifetimes_above_three_hours(monkeypatch):
    monkeypatch.setenv("LITELLM_JWT_ISSUER", "https://login.example.test")
    monkeypatch.setenv("LITELLM_JWT_AUDIENCE", "model-service")
    monkeypatch.setenv("LITELLM_JWT_JWKS_URL", "https://login.example.test/jwks")
    monkeypatch.setenv("LITELLM_JWT_MAX_LIFETIME_SECONDS", "10801")

    with pytest.raises(RuntimeError, match="between 30 and 10800"):
        custom_auth.load_settings()


def test_removed_jwks_key_is_not_kept_in_an_unbounded_per_key_cache(monkeypatch):
    monkeypatch.setattr(custom_auth, 'load_settings', lambda: settings())
    client = custom_auth._get_jwks_client()
    old_key = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rsa.generate_private_key(
        public_exponent=65537, key_size=2048).public_key()))
    old_key.update(kid='old', use='sig', alg='RS256')
    new_key = dict(old_key, kid='new')
    client.jwk_set_cache.put({'keys': [old_key]})
    assert client.get_signing_key('old').key_id == 'old'
    # Equivalent to the next bounded JWKS refresh after the issuer revokes old.
    client.jwk_set_cache.put({'keys': [new_key]})
    monkeypatch.setattr(client, 'fetch_data', lambda: {'keys': [new_key]})
    with pytest.raises(jwt.PyJWKClientError, match='Unable to find'):
        client.get_signing_key('old')


def test_unknown_key_ids_cannot_force_one_jwks_fetch_per_request(monkeypatch):
    from unittest.mock import Mock
    monkeypatch.setattr(custom_auth, 'load_settings', lambda: settings())
    client = custom_auth._get_jwks_client()
    public_key = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rsa.generate_private_key(
        public_exponent=65537, key_size=2048).public_key()))
    public_key.update(kid='known', use='sig', alg='RS256')
    client.jwk_set_cache.put({'keys': [public_key]})
    fetch = Mock(return_value={'keys': [public_key]})
    monkeypatch.setattr(client, 'fetch_data', fetch)
    for index in range(100):
        with pytest.raises(jwt.PyJWKClientError):
            client.get_signing_key(f'unknown-{index}')
    assert fetch.call_count == 1
    assert client.get_signing_key('known').key_id == 'known'


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
            "aud": "model-service",
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
            "aud": "model-service",
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

    with pytest.raises(ProxyException, match="kid is missing"):
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
                    "X-ACCESS-JWT": token,
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
            metadata={"jwt_managed": True},
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
                "X-ACCESS-JWT": token,
                "X-User-Account": "user-001",
            }
        ),
        "Bearer this-value-is-ignored",
    )

    assert result.api_key is None
    assert result.key_alias == "short-lived-jwt"
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
                metadata={"jwt_managed": True},
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
            team=SimpleNamespace(models=[], blocked=False),
            membership=SimpleNamespace(),
        )

    monkeypatch.setattr(custom_auth, "decode_and_validate_token", decode)
    monkeypatch.setattr(custom_auth, "resolve_managed_access", resolve)

    with pytest.raises(ProxyException, match="explicit model list"):
        await custom_auth.user_api_key_auth(
            request_with_headers(
                **{
                    "X-ACCESS-JWT": "header.payload.signature",
                    "X-User-Account": "user-001",
                }
            ),
            "Bearer access-jwt-auth",
        )


@pytest.mark.asyncio
async def test_projected_team_allowlist_rejects_a_model_from_another_group():
    team = LiteLLM_TeamTable(team_id="team-a", models=["model-a"])

    assert await can_team_access_model("model-a", team, None) is True
    with pytest.raises(ProxyException, match="only access models"):
        await can_team_access_model("model-b", team, None)
