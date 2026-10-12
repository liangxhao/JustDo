"""JWT identity and managed-Team authentication.

The shared ASGI entry dispatches JWT requests here and leaves ordinary API keys
and management sessions to LiteLLM's native authentication in the same instance.
"""

import asyncio
import hashlib
import json
import os
import re
import time
from uuid import uuid4
from threading import Lock
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any
from urllib.parse import urlparse

import jwt
from hooks.jwt_auth.errors import JwtAuthError, JwtFailure
from fastapi import Request
from jwt import PyJWKClient

from litellm.proxy._types import (
    LitellmUserRoles,
    ProxyException,
    UserAPIKeyAuth,
)

JWT_HEADER = "X-ACCESS-JWT"
USER_ACCOUNT_HEADER = "X-User-Account"
_MANAGED_TEAM_METADATA_FIELD = "jwt_managed"
_LEGACY_TEAM_METADATA_FIELD = "legacy_clients"
_CLIENT_ROUTES = ["llm_api_routes", "/models", "/v1/models"]
_ALL_TEAM_MODELS = ["all-team-models"]
_MAX_HEADER_LENGTH = 8_192
_MAX_USER_ID_LENGTH = 512
_JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")
_SUPPORTED_ALGORITHMS = frozenset(
    {
        "RS256",
        "RS384",
        "RS512",
        "PS256",
        "PS384",
        "PS512",
        "ES256",
        "ES384",
        "ES512",
        "EdDSA",
    }
)


@dataclass(frozen=True)
class JwtSettings:
    issuer: str
    audience: str
    jwks_url: str
    algorithms: tuple[str, ...]
    max_lifetime_seconds: int
    clock_skew_seconds: int


@dataclass(frozen=True)
class ResolvedAccess:
    user: Any
    team: Any
    membership: Any


def _auth_env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def _required_env(name: str) -> str:
    value = _auth_env(name).strip()
    if not value:
        raise RuntimeError(f"{name} must be configured")
    return value


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = _auth_env(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _is_http_jwks_allowed(hostname: str) -> bool:
    if hostname in {"127.0.0.1", "::1", "localhost"}:
        return True
    return _auth_env("LITELLM_JWT_ALLOW_HTTP_JWKS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


@lru_cache(maxsize=1)
def load_settings() -> JwtSettings:
    algorithms = tuple(
        dict.fromkeys(
            algorithm.strip()
            for algorithm in _auth_env("LITELLM_JWT_ALGORITHMS", "RS256").split(",")
            if algorithm.strip()
        )
    )
    if not algorithms or any(
        algorithm not in _SUPPORTED_ALGORITHMS for algorithm in algorithms
    ):
        raise RuntimeError(
            "LITELLM_JWT_ALGORITHMS contains an unsupported or symmetric algorithm"
        )

    jwks_url = _required_env("LITELLM_JWT_JWKS_URL")
    parsed_jwks_url = urlparse(jwks_url)
    if parsed_jwks_url.scheme not in {"http", "https"} or not parsed_jwks_url.hostname:
        raise RuntimeError("LITELLM_JWT_JWKS_URL must be an absolute HTTP(S) URL")
    if parsed_jwks_url.scheme != "https" and not _is_http_jwks_allowed(
        parsed_jwks_url.hostname
    ):
        raise RuntimeError(
            "LITELLM_JWT_JWKS_URL must use HTTPS unless LITELLM_JWT_ALLOW_HTTP_JWKS is set"
        )

    return JwtSettings(
        issuer=_required_env("LITELLM_JWT_ISSUER"),
        audience=_required_env("LITELLM_JWT_AUDIENCE"),
        jwks_url=jwks_url,
        algorithms=algorithms,
        max_lifetime_seconds=_bounded_int_env(
            "LITELLM_JWT_MAX_LIFETIME_SECONDS", 300, 30, 10800
        ),
        clock_skew_seconds=_bounded_int_env("LITELLM_JWT_CLOCK_SKEW_SECONDS", 30, 0, 60),
    )


@lru_cache(maxsize=1)
def _get_jwks_client() -> PyJWKClient:
    settings = load_settings()
    return _BoundedJwksClient(
        settings.jwks_url,
        # Per-key LRU caching has no expiry and would keep revoked keys alive.
        cache_keys=False,
        cache_jwk_set=True,
        lifespan=300,
        timeout=5,
    )


class _BoundedJwksClient(PyJWKClient):
    """Single-flight fetches and bound unknown-kid refreshes per proxy worker."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._fetch_lock = Lock()
        self._last_refresh = float('-inf')

    def get_signing_key(self, kid):
        with self._fetch_lock:
            if self.jwk_set_cache is None or self.jwk_set_cache.get() is None:
                # Also throttle failed requests while the issuer is unavailable.
                if time.monotonic() - self._last_refresh < 5:
                    raise jwt.PyJWKClientConnectionError('JWKS temporarily unavailable')
                self._last_refresh = time.monotonic()
            keys = self.get_signing_keys()
            key = self.match_kid(keys, kid)
            if key is None and time.monotonic() - self._last_refresh >= 5:
                self._last_refresh = time.monotonic()
                key = self.match_kid(self.get_signing_keys(refresh=True), kid)
            if key is None:
                raise jwt.PyJWKClientError('Unable to find a signing key')
            return key


def _proxy_error(failure: JwtFailure) -> JwtAuthError:
    return JwtAuthError(failure)


def _jwt_from_authorization(api_key: Any) -> str:
    if not isinstance(api_key, str):
        return ""
    value = api_key.strip()
    if value.lower().startswith("bearer "):
        value = value[7:].strip()
    return value if _JWT_SHAPE.fullmatch(value) else ""


def _required_claim_string(claims: dict[str, Any], name: str) -> str:
    value = claims.get(name)
    if not isinstance(value, str) or not value.strip():
        raise _proxy_error(JwtFailure.CLAIMS)
    return value.strip()


def validate_claims(
    claims: dict[str, Any], settings: JwtSettings, now_seconds: int | None = None
) -> tuple[str, int]:
    user_id = _required_claim_string(claims, "sub")
    _required_claim_string(claims, "jti")
    if len(user_id) > _MAX_USER_ID_LENGTH or any(
        ord(char) < 32 or ord(char) == 127 for char in user_id
    ):
        raise _proxy_error(JwtFailure.CLAIMS)

    issued_at = claims.get("iat")
    expires_at = claims.get("exp")
    if (
        isinstance(issued_at, bool)
        or not isinstance(issued_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
    ):
        raise _proxy_error(JwtFailure.TIMESTAMPS)

    now = int(time.time()) if now_seconds is None else now_seconds
    if issued_at > now + settings.clock_skew_seconds:
        raise _proxy_error(JwtFailure.NOT_YET_VALID)
    if expires_at <= now:
        raise _proxy_error(JwtFailure.EXPIRED)
    if (
        expires_at <= issued_at
        or expires_at - issued_at > settings.max_lifetime_seconds
        or expires_at > now + settings.max_lifetime_seconds
    ):
        raise _proxy_error(JwtFailure.LIFETIME)
    return user_id, expires_at


async def decode_and_validate_token(token: str) -> tuple[dict[str, Any], str, int]:
    try:
        settings = load_settings()
    except Exception:
        raise _proxy_error(JwtFailure.CONFIGURATION) from None
    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        key_id = header.get("kid")
        if (
            not isinstance(algorithm, str)
            or algorithm not in settings.algorithms
            or not isinstance(key_id, str)
            or not key_id.strip()
        ):
            raise _proxy_error(JwtFailure.HEADER)
        signing_key = await asyncio.to_thread(
            _get_jwks_client().get_signing_key_from_jwt,
            token,
        )
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=list(settings.algorithms),
            audience=settings.audience,
            issuer=settings.issuer,
            leeway=0,
            options={
                "require": ["aud", "exp", "iat", "iss", "jti", "sub"],
                "verify_iat": False,
            },
        )
    except ProxyException:
        raise
    except jwt.ExpiredSignatureError:
        raise _proxy_error(JwtFailure.EXPIRED) from None
    except jwt.InvalidSignatureError:
        raise _proxy_error(JwtFailure.SIGNATURE) from None
    except jwt.InvalidIssuerError:
        raise _proxy_error(JwtFailure.ISSUER) from None
    except jwt.InvalidAudienceError:
        raise _proxy_error(JwtFailure.AUDIENCE) from None
    except jwt.ImmatureSignatureError:
        raise _proxy_error(JwtFailure.NOT_YET_VALID) from None
    except jwt.MissingRequiredClaimError:
        raise _proxy_error(JwtFailure.CLAIMS) from None
    except jwt.PyJWKClientConnectionError:
        raise _proxy_error(JwtFailure.JWKS) from None
    except jwt.PyJWKClientError:
        raise _proxy_error(JwtFailure.SIGNING_KEY) from None
    except jwt.InvalidTokenError:
        raise _proxy_error(JwtFailure.INVALID) from None
    except Exception:
        raise _proxy_error(JwtFailure.INTERNAL) from None

    if not isinstance(claims, dict):
        raise _proxy_error(JwtFailure.CLAIMS)
    user_id, expires_at = validate_claims(claims, settings)
    return claims, user_id, expires_at


def _metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _required_team_models(team: Any) -> list[str]:
    models = getattr(team, "models", None)
    if (
        not isinstance(models, list)
        or not models
        or any(not isinstance(model, str) or not model.strip() for model in models)
    ):
        raise _proxy_error(JwtFailure.MODELS)
    return list(dict.fromkeys(model.strip() for model in models))


async def provision_first_login(db: Any, user_id: str, team_id: str) -> None:
    """Atomically enroll only a never-provisioned user. Existing users are untouched.

    PostgreSQL uniqueness and the team row lock coordinate multiple proxy workers;
    no process-local lock or client-supplied group is trusted.
    """
    if not team_id or await db.litellm_usertable.find_unique(where={"user_id": user_id}):
        return
    async with db.tx() as tx:
        teams = await tx.query_raw(
            'SELECT * FROM "LiteLLM_TeamTable" WHERE team_id = $1 FOR UPDATE', team_id
        )
        if not teams:
            raise _proxy_error(JwtFailure.DEFAULT_TEAM)
        team = teams[0]
        metadata = _metadata(team.get("metadata"))
        if (metadata.get(_MANAGED_TEAM_METADATA_FIELD) is not True
                or metadata.get(_LEGACY_TEAM_METADATA_FIELD) is True
                or team.get("blocked") is not False):
            raise _proxy_error(JwtFailure.DEFAULT_TEAM)
        from types import SimpleNamespace
        _required_team_models(SimpleNamespace(models=team.get("models")))
        # ON CONFLICT also protects against a concurrent administrative user create.
        created = await tx.query_raw(
            'INSERT INTO "LiteLLM_UserTable" '
            '(user_id, user_role, teams, models, metadata) '
            "VALUES ($1, 'internal_user', ARRAY[$2]::text[], ARRAY[]::text[], "
            "'{\"jwt_auto_provisioned\":true}'::jsonb) "
            'ON CONFLICT (user_id) DO NOTHING RETURNING user_id', user_id, team_id
        )
        if not created:
            return
        budget_id = await _create_member_budget(tx, team, metadata)
        await tx.execute_raw(
            'INSERT INTO "LiteLLM_TeamMembership" (user_id, team_id, budget_id) VALUES ($1, $2, $3)',
            user_id, team_id, budget_id,
        )
        members = team.get("members_with_roles")
        if isinstance(members, str):
            members = json.loads(members)
        if members == {}:
            members = []
        if not isinstance(members, list) or any(not isinstance(member, dict) for member in members):
            raise _proxy_error(JwtFailure.ROSTER)
        members = [member for member in members if member.get("user_id") != user_id]
        members.append({"role": "user", "user_id": user_id})
        await tx.execute_raw(
            'UPDATE "LiteLLM_TeamTable" SET members_with_roles = $2::jsonb, '
            'updated_at = CURRENT_TIMESTAMP WHERE team_id = $1',
            team_id, json.dumps(members),
        )


async def _create_member_budget(tx: Any, team: dict, metadata: dict) -> str | None:
    """Preserve Team default member restrictions inside the enrollment transaction."""
    from litellm.proxy.common_utils.timezone_utils import get_budget_reset_time

    data: dict[str, Any] = {
        "created_by": "model-auth-enrollment",
        "updated_by": "model-auth-enrollment",
    }
    default_id = metadata.get("team_member_budget_id")
    if default_id is not None:
        if not isinstance(default_id, str) or not default_id.strip():
            raise _proxy_error(JwtFailure.MEMBER_BUDGET)
        budget = await tx.litellm_budgettable.find_unique(where={"budget_id": default_id})
        if budget is None:
            raise _proxy_error(JwtFailure.MEMBER_BUDGET)
        for field in (
            "max_budget", "soft_budget", "max_parallel_requests", "tpm_limit",
            "rpm_limit", "model_max_budget", "budget_duration", "allowed_models",
        ):
            value = getattr(budget, field, None)
            if value is not None:
                data[field] = value
    models = team.get("default_team_member_models")
    if models:
        if not isinstance(models, list) or any(not isinstance(model, str) or not model.strip() for model in models):
            raise _proxy_error(JwtFailure.MEMBER_MODELS)
        data["allowed_models"] = models
    if len(data) == 2:
        return None
    if data.get("budget_duration"):
        data["budget_reset_at"] = get_budget_reset_time(data["budget_duration"])
    budget_id = str(uuid4())
    await tx.execute_raw(
        'INSERT INTO "LiteLLM_BudgetTable" '
        '(budget_id, max_budget, soft_budget, max_parallel_requests, tpm_limit, rpm_limit, '
        'model_max_budget, budget_duration, budget_reset_at, allowed_models, created_by, updated_by) '
        'VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::text[], $11, $11)',
        budget_id, data.get("max_budget"), data.get("soft_budget"),
        data.get("max_parallel_requests"), data.get("tpm_limit"), data.get("rpm_limit"),
        json.dumps(data["model_max_budget"]) if data.get("model_max_budget") is not None else None,
        data.get("budget_duration"), data.get("budget_reset_at"),
        data.get("allowed_models", []), data["created_by"],
    )
    return budget_id


async def resolve_managed_access(user_id: str) -> ResolvedAccess:
    from litellm.proxy.auth.auth_checks import (
        get_team_membership,
        get_team_object,
        get_user_object,
    )
    from litellm.proxy.proxy_server import (
        prisma_client,
        proxy_logging_obj,
        user_api_key_cache,
    )

    async def read_user():
        return await get_user_object(
            user_id=user_id, prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache, user_id_upsert=False,
            proxy_logging_obj=proxy_logging_obj,
        )

    try:
        user = await read_user()
    except Exception:
        user = None

    if user is None and _auth_env("LITELLM_DEFAULT_TEAM_ID").strip():
        try:
            await provision_first_login(prisma_client.db, user_id,
                                        _auth_env("LITELLM_DEFAULT_TEAM_ID").strip())
            # Bypass LiteLLM's missing-user lookup throttle immediately after creation.
            from litellm.proxy._types import LiteLLM_UserTable
            row = await prisma_client.db.litellm_usertable.find_unique(where={"user_id": user_id})
            user = LiteLLM_UserTable.model_validate(dict(row)) if row else None
            if user is not None:
                from litellm.proxy.common_utils.user_api_key_cache import get_management_object_ttl
                await user_api_key_cache.async_set_cache(
                    key=user_id, value=user, model_type=LiteLLM_UserTable,
                    ttl=get_management_object_ttl(user_api_key_cache),
                )
        except JwtAuthError:
            raise
        except Exception:
            raise _proxy_error(JwtFailure.ENROLLMENT) from None

    if user is None:
        raise _proxy_error(JwtFailure.USER)

    team_ids = tuple(
        dict.fromkeys(
            team_id.strip()
            for team_id in (user.teams or [])
            if isinstance(team_id, str) and team_id.strip()
        )
    )
    managed_teams: list[Any] = []
    for team_id in team_ids:
        try:
            team = await get_team_object(
                team_id=team_id,
                prisma_client=prisma_client,
                user_api_key_cache=user_api_key_cache,
                proxy_logging_obj=proxy_logging_obj,
                team_id_upsert=False,
            )
        except Exception:
            raise _proxy_error(JwtFailure.TEAM_LOOKUP) from None
        metadata = _metadata(team.metadata)
        if (
            metadata.get(_MANAGED_TEAM_METADATA_FIELD) is True
            and metadata.get(_LEGACY_TEAM_METADATA_FIELD) is not True
        ):
            managed_teams.append(team)

    if len(managed_teams) != 1:
        raise _proxy_error(JwtFailure.TEAM)

    team = managed_teams[0]
    membership = await get_team_membership(
        user_id=user_id,
        team_id=team.team_id,
        prisma_client=prisma_client,
        user_api_key_cache=user_api_key_cache,
        proxy_logging_obj=proxy_logging_obj,
    )
    if membership is None:
        raise _proxy_error(JwtFailure.MEMBERSHIP)
    return ResolvedAccess(user=user, team=team, membership=membership)


async def user_api_key_auth(request: Request, api_key: str) -> UserAPIKeyAuth:
    """Validate a short-lived JWT and resolve its persistent LiteLLM Team."""
    try:
        return await _authenticate(request, api_key)
    except JwtAuthError:
        raise
    except Exception:
        raise _proxy_error(JwtFailure.INTERNAL) from None


async def _authenticate(request: Request, api_key: str) -> UserAPIKeyAuth:

    header_token = request.headers.get(JWT_HEADER, "").strip()
    authorization_token = _jwt_from_authorization(api_key)
    token = header_token or authorization_token
    account = request.headers.get(USER_ACCOUNT_HEADER, "").strip()
    if (
        not token
        or len(token) > _MAX_HEADER_LENGTH
        or not _JWT_SHAPE.fullmatch(token)
        or len(account) > _MAX_USER_ID_LENGTH
    ):
        raise _proxy_error(JwtFailure.CREDENTIALS)
    if header_token and not account:
        raise _proxy_error(JwtFailure.CREDENTIALS)
    if header_token and authorization_token and header_token != authorization_token:
        raise _proxy_error(JwtFailure.CONFLICT)

    claims, user_id, expires_at = await decode_and_validate_token(token)
    if account and account != user_id:
        raise _proxy_error(JwtFailure.ACCOUNT)

    access = await resolve_managed_access(user_id)
    team = access.team
    if team.blocked:
        raise _proxy_error(JwtFailure.BLOCKED)
    user = access.user
    membership = access.membership
    team_models = _required_team_models(team)
    auth = UserAPIKeyAuth(
        api_key=None,
        token=hashlib.sha256(f"jwt-user:{user_id}".encode("utf-8")).hexdigest(),
        key_alias="short-lived-jwt",
        allowed_routes=_CLIENT_ROUTES,
        models=_ALL_TEAM_MODELS,
        user_id=user_id,
        user_role=LitellmUserRoles.INTERNAL_USER,
        user_email=user.user_email,
        user_spend=user.spend,
        user_max_budget=user.max_budget,
        user_tpm_limit=user.tpm_limit,
        user_rpm_limit=user.rpm_limit,
        user_model_max_budget=user.model_max_budget,
        end_user_id=user_id,
        team_id=team.team_id,
        team_alias=team.team_alias,
        team_spend=team.spend,
        team_max_budget=team.max_budget,
        team_soft_budget=team.soft_budget,
        team_tpm_limit=team.tpm_limit,
        team_rpm_limit=team.rpm_limit,
        team_models=team_models,
        team_blocked=team.blocked,
        team_metadata=team.metadata,
        team_object_permission_id=team.object_permission_id,
        team_member_spend=membership.spend,
        team_member_rpm_limit=membership.safe_get_team_member_rpm_limit(),
        team_member_tpm_limit=membership.safe_get_team_member_tpm_limit(),
        expires=datetime.fromtimestamp(expires_at, tz=timezone.utc),
        jwt_claims={
            claim: claims[claim]
            for claim in ("iss", "aud", "sub", "iat", "exp", "jti")
            if claim in claims
        },
    )
    auth.team_object_permission = getattr(team, "object_permission", None)
    return auth
