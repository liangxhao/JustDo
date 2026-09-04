"""JustDo short-lived JWT authentication for the LiteLLM OSS data plane.

The public compatibility router sends requests carrying ``X-JustDo-JWT`` to
the LiteLLM instance that loads this hook. Legacy requests never reach this
instance; they are handled by a separate native Virtual Key data plane.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any
from urllib.parse import urlparse

import jwt
from fastapi import Request, status
from jwt import PyJWKClient

from litellm.proxy._types import (
    LitellmUserRoles,
    ProxyErrorTypes,
    ProxyException,
    UserAPIKeyAuth,
)

JWT_HEADER = "X-JustDo-JWT"
USER_ACCOUNT_HEADER = "X-User-Account"
_MANAGED_TEAM_METADATA_FIELD = "justdo_managed"
_LEGACY_TEAM_METADATA_FIELD = "justdo_legacy_clients"
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


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} must be configured")
    return value


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


@lru_cache(maxsize=1)
def load_settings() -> JwtSettings:
    algorithms = tuple(
        dict.fromkeys(
            algorithm.strip()
            for algorithm in os.getenv("JUSTDO_JWT_ALGORITHMS", "RS256").split(",")
            if algorithm.strip()
        )
    )
    if not algorithms or any(
        algorithm not in _SUPPORTED_ALGORITHMS for algorithm in algorithms
    ):
        raise RuntimeError(
            "JUSTDO_JWT_ALGORITHMS contains an unsupported or symmetric algorithm"
        )

    jwks_url = _required_env("JUSTDO_JWT_JWKS_URL")
    parsed_jwks_url = urlparse(jwks_url)
    if parsed_jwks_url.scheme not in {"http", "https"} or not parsed_jwks_url.hostname:
        raise RuntimeError("JUSTDO_JWT_JWKS_URL must be an absolute HTTP(S) URL")
    if parsed_jwks_url.scheme != "https" and parsed_jwks_url.hostname not in {
        "127.0.0.1",
        "::1",
        "localhost",
    }:
        raise RuntimeError(
            "JUSTDO_JWT_JWKS_URL must use HTTPS unless it targets loopback"
        )

    return JwtSettings(
        issuer=_required_env("JUSTDO_JWT_ISSUER"),
        audience=_required_env("JUSTDO_JWT_AUDIENCE"),
        jwks_url=jwks_url,
        algorithms=algorithms,
        max_lifetime_seconds=_bounded_int_env(
            "JUSTDO_JWT_MAX_LIFETIME_SECONDS", 300, 30, 300
        ),
        clock_skew_seconds=_bounded_int_env("JUSTDO_JWT_CLOCK_SKEW_SECONDS", 30, 0, 60),
    )


@lru_cache(maxsize=1)
def _get_jwks_client() -> PyJWKClient:
    settings = load_settings()
    return PyJWKClient(
        settings.jwks_url,
        cache_keys=True,
        max_cached_keys=32,
        cache_jwk_set=True,
        lifespan=300,
        timeout=5,
    )


def _proxy_error(
    message: str, code: int = status.HTTP_401_UNAUTHORIZED
) -> ProxyException:
    return ProxyException(
        message=message,
        type=ProxyErrorTypes.auth_error,
        param=JWT_HEADER,
        code=code,
    )


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
        raise _proxy_error(f"Authentication failed: JWT claim {name} is required")
    return value.strip()


def validate_claims(
    claims: dict[str, Any], settings: JwtSettings, now_seconds: int | None = None
) -> tuple[str, int]:
    user_id = _required_claim_string(claims, "sub")
    _required_claim_string(claims, "jti")
    if len(user_id) > _MAX_USER_ID_LENGTH or any(
        ord(char) < 32 or ord(char) == 127 for char in user_id
    ):
        raise _proxy_error("Authentication failed: invalid JWT subject")

    issued_at = claims.get("iat")
    expires_at = claims.get("exp")
    if (
        isinstance(issued_at, bool)
        or not isinstance(issued_at, int)
        or isinstance(expires_at, bool)
        or not isinstance(expires_at, int)
    ):
        raise _proxy_error(
            "Authentication failed: JWT iat and exp must be integer timestamps"
        )

    now = int(time.time()) if now_seconds is None else now_seconds
    if issued_at > now + settings.clock_skew_seconds:
        raise _proxy_error("Authentication failed: JWT was issued in the future")
    if expires_at <= now:
        raise _proxy_error("Authentication failed: JWT has expired")
    if (
        expires_at <= issued_at
        or expires_at - issued_at > settings.max_lifetime_seconds
        or expires_at > now + settings.max_lifetime_seconds
    ):
        raise _proxy_error(
            "Authentication failed: JWT lifetime exceeds the configured maximum"
        )
    return user_id, expires_at


async def decode_and_validate_token(token: str) -> tuple[dict[str, Any], str, int]:
    settings = load_settings()
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
            raise ValueError("JWT header is missing an allowed alg or kid")
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
    except Exception as error:
        raise _proxy_error("Authentication failed: JWT validation failed") from error

    if not isinstance(claims, dict):
        raise _proxy_error("Authentication failed: JWT payload is invalid")
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
        raise _proxy_error(
            "Authorization failed: active JustDo Team must have an explicit model list",
            status.HTTP_403_FORBIDDEN,
        )
    return list(dict.fromkeys(model.strip() for model in models))


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

    try:
        user = await get_user_object(
            user_id=user_id,
            prisma_client=prisma_client,
            user_api_key_cache=user_api_key_cache,
            user_id_upsert=False,
            proxy_logging_obj=proxy_logging_obj,
        )
    except Exception as error:
        raise _proxy_error(
            "Authorization failed: user is not provisioned in LiteLLM",
            status.HTTP_403_FORBIDDEN,
        ) from error

    if user is None:
        raise _proxy_error(
            "Authorization failed: user is not provisioned in LiteLLM",
            status.HTTP_403_FORBIDDEN,
        )

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
            continue
        metadata = _metadata(team.metadata)
        if (
            metadata.get(_MANAGED_TEAM_METADATA_FIELD) is True
            and metadata.get(_LEGACY_TEAM_METADATA_FIELD) is not True
        ):
            managed_teams.append(team)

    if len(managed_teams) != 1:
        raise _proxy_error(
            "Authorization failed: user must belong to exactly one active JustDo Team",
            status.HTTP_403_FORBIDDEN,
        )

    team = managed_teams[0]
    membership = await get_team_membership(
        user_id=user_id,
        team_id=team.team_id,
        prisma_client=prisma_client,
        user_api_key_cache=user_api_key_cache,
        proxy_logging_obj=proxy_logging_obj,
    )
    if membership is None:
        raise _proxy_error(
            "Authorization failed: active JustDo Team membership was not found",
            status.HTTP_403_FORBIDDEN,
        )
    return ResolvedAccess(user=user, team=team, membership=membership)


async def user_api_key_auth(request: Request, api_key: str) -> UserAPIKeyAuth:
    """Validate a short-lived JWT and resolve its persistent LiteLLM Team."""

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
        raise _proxy_error(
            "Authentication failed: required JustDo identity headers are missing"
        )
    if header_token and not account:
        raise _proxy_error(
            "Authentication failed: required JustDo identity headers are missing"
        )
    if header_token and authorization_token and header_token != authorization_token:
        raise _proxy_error("Authentication failed: conflicting JWT credentials")

    claims, user_id, expires_at = await decode_and_validate_token(token)
    if account and account != user_id:
        raise _proxy_error(
            "Authentication failed: account header does not match JWT subject"
        )

    access = await resolve_managed_access(user_id)
    team = access.team
    user = access.user
    membership = access.membership
    team_models = _required_team_models(team)
    auth = UserAPIKeyAuth(
        api_key=None,
        token=hashlib.sha256(f"justdo-jwt-user:{user_id}".encode("utf-8")).hexdigest(),
        key_alias="justdo-short-lived-jwt",
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
