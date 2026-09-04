#!/usr/bin/env python3
# ruff: noqa: T201 -- this is an operator-facing CLI
"""Provision persistent LiteLLM Teams and the temporary legacy Virtual Key."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

_INTERNAL_USER_ROLE = "internal_user"
_MANAGED_TEAM_METADATA = {"justdo_managed": True}
_CLIENT_ROUTES = ["llm_api_routes", "/models", "/v1/models"]
_ALL_TEAM_MODELS = ["all-team-models"]
_LEGACY_KEY_DURATION = "30d"
_LEGACY_KEY_MAX_AGE = timedelta(days=30, minutes=5)
_MAX_VIRTUAL_KEY_LENGTH = 8_192
_JWT_SHAPE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class TeamSpec:
    team_id: str
    team_alias: str
    models: tuple[str, ...]
    users: tuple[str, ...]
    max_budget: float | None = None
    budget_duration: str | None = None
    tpm_limit: int | None = None
    rpm_limit: int | None = None
    blocked: bool | None = None


@dataclass(frozen=True)
class LegacyClientSpec:
    team: TeamSpec
    key_alias: str


@dataclass(frozen=True)
class ProvisioningSpec:
    teams: tuple[TeamSpec, ...]
    legacy_client: LegacyClientSpec | None


class LiteLLMApiError(RuntimeError):
    def __init__(self, path: str, status: int):
        super().__init__(f"LiteLLM request failed: path={path} status={status}")
        self.path = path
        self.status = status


class LiteLLMAdminClient:
    def __init__(self, base_url: str, master_key: str):
        self.base_url = base_url.rstrip("/")
        self.master_key = master_key

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        allow_not_found: bool = False,
    ) -> dict[str, Any] | None:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self.master_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                raw_body = response.read()
        except urllib.error.HTTPError as error:
            if allow_not_found and error.code == 404:
                return None
            raise LiteLLMApiError(path.split("?", 1)[0], error.code) from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"LiteLLM is unavailable at {self.base_url}.") from error
        if not raw_body:
            return {}
        decoded = json.loads(raw_body)
        return decoded if isinstance(decoded, dict) else {}

    def get_team(self, team_id: str) -> dict[str, Any] | None:
        encoded = urllib.parse.urlencode({"team_id": team_id})
        return self.request("GET", f"/team/info?{encoded}", allow_not_found=True)

    def upsert_team(self, team: TeamSpec, *, legacy: bool = False) -> None:
        existing_team = self.get_team(team.team_id)
        existing_team_info = (
            existing_team.get("team_info", existing_team)
            if isinstance(existing_team, dict)
            else {}
        )
        metadata = _mapping_field(existing_team_info, "metadata")
        metadata.pop("justdo_legacy_clients", None)
        payload: dict[str, Any] = {
            "team_id": team.team_id,
            "team_alias": team.team_alias,
            "models": list(team.models),
            "metadata": {
                **metadata,
                **_MANAGED_TEAM_METADATA,
                **({"justdo_legacy_clients": True} if legacy else {}),
            },
        }
        for field_name in (
            "max_budget",
            "budget_duration",
            "tpm_limit",
            "rpm_limit",
            "blocked",
        ):
            value = getattr(team, field_name)
            if value is not None:
                payload[field_name] = value
        if existing_team is None:
            self.request("POST", "/team/new", payload)
            print(f"created team {team.team_id}")
        else:
            self.request("POST", "/team/update", payload)
            print(f"updated team {team.team_id}")

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        encoded = urllib.parse.urlencode({"user_id": user_id})
        return self.request("GET", f"/user/info?{encoded}", allow_not_found=True)

    def ensure_user(self, user_id: str) -> dict[str, Any]:
        user = self.get_user(user_id)
        path = "/user/new" if user is None else "/user/update"
        payload: dict[str, Any] = {
            "user_id": user_id,
            "user_role": _INTERNAL_USER_ROLE,
            "models": [],
        }
        if user is None:
            payload["auto_create_key"] = False
        self.request("POST", path, payload)
        print(f"{'created' if user is None else 'updated'} user {user_id}")

        refreshed = self.get_user(user_id)
        if refreshed is None:
            raise RuntimeError(f"User {user_id} was not readable after provisioning.")
        return refreshed

    def team_is_managed(self, team_id: str) -> bool:
        response = self.get_team(team_id)
        if response is None:
            return False
        team_info = response.get("team_info", response)
        metadata = _mapping_field(team_info, "metadata")
        return (
            metadata.get("justdo_managed") is True
            and metadata.get("justdo_legacy_clients") is not True
        )

    def assign_exclusive_managed_team(
        self,
        user_id: str,
        target_team_id: str,
        user_response: dict[str, Any],
    ) -> None:
        user_info = user_response.get("user_info", {})
        raw_team_ids = user_info.get("teams", []) if isinstance(user_info, dict) else []
        existing_team_ids = [
            team_id.strip()
            for team_id in raw_team_ids
            if isinstance(team_id, str) and team_id.strip()
        ]
        for team_id in existing_team_ids:
            if team_id == target_team_id or not self.team_is_managed(team_id):
                continue
            self.request(
                "POST",
                "/team/member_delete",
                {"team_id": team_id, "user_id": user_id},
            )
            print(f"removed user {user_id} from managed team {team_id}")

        if target_team_id not in existing_team_ids:
            self.request(
                "POST",
                "/team/member_add",
                {
                    "team_id": target_team_id,
                    "member": {"role": "user", "user_id": user_id},
                },
            )
            print(f"assigned user {user_id} to managed team {target_team_id}")

    def _get_single_key(
        self,
        *,
        key_alias: str | None = None,
        key_hash: str | None = None,
    ) -> dict[str, Any] | None:
        query: dict[str, str] = {"return_full_object": "true", "size": "100"}
        if key_alias is not None:
            query["key_alias"] = key_alias
        if key_hash is not None:
            query["key_hash"] = key_hash
        response = (
            self.request("GET", f"/key/list?{urllib.parse.urlencode(query)}") or {}
        )
        keys = response.get("keys", [])
        if not isinstance(keys, list):
            raise RuntimeError("LiteLLM returned an invalid /key/list response.")
        objects = [item for item in keys if isinstance(item, dict)]
        if len(objects) > 1:
            identifier = key_alias if key_alias is not None else key_hash
            raise RuntimeError(f"More than one LiteLLM key matched {identifier}.")
        return objects[0] if objects else None

    def ensure_legacy_virtual_key(
        self,
        legacy: LegacyClientSpec,
        virtual_key: str,
    ) -> None:
        _validate_legacy_virtual_key(virtual_key)
        expected_hash = _hash_token(virtual_key)
        existing_key = self._get_single_key(key_alias=legacy.key_alias)
        metadata = {
            "justdo_managed": True,
            "justdo_legacy_clients": True,
            "justdo_legacy_expires_after": _LEGACY_KEY_DURATION,
        }

        if existing_key is not None:
            if existing_key.get("token") != expected_hash:
                raise RuntimeError(
                    f"Legacy key alias {legacy.key_alias} already belongs to a different token."
                )
            expires = _parse_optional_datetime(existing_key.get("expires"))
            if expires is not None and expires <= datetime.now(timezone.utc):
                raise RuntimeError(
                    "The legacy Virtual Key is already expired and will not be renewed. "
                    "Delete it after completing the migration."
                )
            if (
                expires is not None
                and expires > datetime.now(timezone.utc) + _LEGACY_KEY_MAX_AGE
            ):
                raise RuntimeError(
                    "The legacy Virtual Key expiry exceeds the 30-day migration window."
                )
            payload: dict[str, Any] = {
                "key_alias": legacy.key_alias,
                "team_id": legacy.team.team_id,
                "models": _ALL_TEAM_MODELS,
                "allowed_routes": _CLIENT_ROUTES,
                "metadata": {**_mapping_field(existing_key, "metadata"), **metadata},
            }
            if expires is None:
                payload["duration"] = _LEGACY_KEY_DURATION
            self.request("POST", "/key/update", payload)
            print(
                "updated legacy-client Virtual Key without extending its existing expiry"
            )
            return

        key_with_same_token = self._get_single_key(key_hash=expected_hash)
        if key_with_same_token is not None:
            raise RuntimeError(
                "The legacy token already exists under a different LiteLLM key alias."
            )
        self.request(
            "POST",
            "/key/generate",
            {
                "key": virtual_key,
                "key_alias": legacy.key_alias,
                "team_id": legacy.team.team_id,
                "models": _ALL_TEAM_MODELS,
                "allowed_routes": _CLIENT_ROUTES,
                "duration": _LEGACY_KEY_DURATION,
                "metadata": metadata,
            },
        )
        print("created legacy-client Virtual Key with a 30-day expiry")


def _mapping_field(value: Any, field_name: str) -> dict[str, Any]:
    raw_value = value.get(field_name, {}) if isinstance(value, dict) else {}
    if isinstance(raw_value, str):
        try:
            raw_value = json.loads(raw_value)
        except json.JSONDecodeError:
            return {}
    return raw_value if isinstance(raw_value, dict) else {}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _parse_optional_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise RuntimeError("LiteLLM returned an invalid legacy key expiry.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError("LiteLLM returned an invalid legacy key expiry.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _validate_legacy_virtual_key(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("sk-"):
        raise ValueError(
            "Legacy Virtual Key must be a non-empty value beginning with sk-."
        )
    if len(value) < 4 or len(value) > _MAX_VIRTUAL_KEY_LENGTH:
        raise ValueError("Legacy Virtual Key has an invalid length.")
    if _JWT_SHAPE.fullmatch(value):
        raise ValueError(
            "Legacy Virtual Key must not have JWT shape because the compatibility "
            "router reserves JWT-shaped credentials for the new data plane."
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("Legacy Virtual Key contains unsafe control characters.")
    return value


def _required_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    return value.strip()


def _string_list(
    value: Any, field_name: str, *, allow_empty: bool = False
) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be an array")
    normalized = tuple(
        dict.fromkeys(_required_string(item, f"{field_name} item") for item in value)
    )
    if not normalized and not allow_empty:
        raise ValueError(f"{field_name} must not be empty")
    return normalized


def _optional_non_negative_number(value: Any, field_name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a non-negative number")
    normalized = float(value)
    if not math.isfinite(normalized) or normalized < 0:
        raise ValueError(f"{field_name} must be a non-negative number")
    return normalized


def _optional_positive_int(value: Any, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field_name} must be a positive integer")
    return value


def _optional_boolean(value: Any, field_name: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"{field_name} must be a boolean")
    return value


def _parse_team(raw_team: Any, field_name: str, *, include_users: bool) -> TeamSpec:
    if not isinstance(raw_team, dict):
        raise ValueError(f"{field_name} must be an object")
    raw_budget_duration = raw_team.get("budget_duration")
    return TeamSpec(
        team_id=_required_string(raw_team.get("team_id"), f"{field_name}.team_id"),
        team_alias=_required_string(
            raw_team.get("team_alias"), f"{field_name}.team_alias"
        ),
        models=_string_list(raw_team.get("models"), f"{field_name}.models"),
        users=(
            _string_list(raw_team.get("users"), f"{field_name}.users")
            if include_users
            else ()
        ),
        max_budget=_optional_non_negative_number(
            raw_team.get("max_budget"), f"{field_name}.max_budget"
        ),
        budget_duration=(
            _required_string(raw_budget_duration, f"{field_name}.budget_duration")
            if raw_budget_duration is not None
            else None
        ),
        tpm_limit=_optional_positive_int(
            raw_team.get("tpm_limit"), f"{field_name}.tpm_limit"
        ),
        rpm_limit=_optional_positive_int(
            raw_team.get("rpm_limit"), f"{field_name}.rpm_limit"
        ),
        blocked=_optional_boolean(raw_team.get("blocked"), f"{field_name}.blocked"),
    )


def load_provisioning_spec(config_path: Path) -> ProvisioningSpec:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("configuration root must be an object")
    raw_teams = payload.get("teams")
    if not isinstance(raw_teams, list) or not raw_teams:
        raise ValueError("teams must be a non-empty array")

    teams: list[TeamSpec] = []
    team_ids: set[str] = set()
    assigned_users: set[str] = set()
    for index, raw_team in enumerate(raw_teams):
        team = _parse_team(raw_team, f"teams[{index}]", include_users=True)
        if team.team_id in team_ids:
            raise ValueError(f"team_id appears more than once: {team.team_id}")
        duplicate_users = assigned_users.intersection(team.users)
        if duplicate_users:
            raise ValueError(
                "Each user must appear in exactly one configured team; duplicates: "
                + ", ".join(sorted(duplicate_users))
            )
        team_ids.add(team.team_id)
        assigned_users.update(team.users)
        teams.append(team)

    legacy_client: LegacyClientSpec | None = None
    raw_legacy = payload.get("legacy_client")
    if raw_legacy is not None:
        legacy_team = _parse_team(raw_legacy, "legacy_client", include_users=False)
        if legacy_team.team_id in team_ids:
            raise ValueError(f"team_id appears more than once: {legacy_team.team_id}")
        legacy_client = LegacyClientSpec(
            team=legacy_team,
            key_alias=_required_string(
                raw_legacy.get("key_alias", "justdo-legacy-client"),
                "legacy_client.key_alias",
            ),
        )
    return ProvisioningSpec(teams=tuple(teams), legacy_client=legacy_client)


def load_team_specs(config_path: Path) -> list[TeamSpec]:
    return list(load_provisioning_spec(config_path).teams)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", type=Path, help="Path to a groups JSON file")
    parser.add_argument(
        "--base-url",
        default=os.getenv("LITELLM_BASE_URL", "http://127.0.0.1:9108"),
    )
    parser.add_argument(
        "--legacy-key-env",
        help=(
            "Read the old desktop key from this environment variable and register it as "
            "the one 30-day legacy Virtual Key; this operation always runs last"
        ),
    )
    args = parser.parse_args()

    master_key = os.getenv("LITELLM_MASTER_KEY", "")
    if not master_key:
        print(
            "LITELLM_MASTER_KEY must be set in the process environment.",
            file=sys.stderr,
        )
        return 2

    try:
        spec = load_provisioning_spec(args.config)
        legacy_key: str | None = None
        if args.legacy_key_env is not None:
            if spec.legacy_client is None:
                raise ValueError("--legacy-key-env requires a legacy_client block")
            legacy_key = os.getenv(args.legacy_key_env, "")
            if not legacy_key:
                raise ValueError(
                    f"Environment variable {args.legacy_key_env} must contain the old client key"
                )
            if legacy_key == master_key:
                raise ValueError(
                    "The old client key is still the LiteLLM master key. Rotate "
                    "LITELLM_MASTER_KEY and restart LiteLLM before registering the old "
                    "value as the restricted legacy Virtual Key."
                )

        client = LiteLLMAdminClient(args.base_url, master_key)
        for team in spec.teams:
            client.upsert_team(team)
        if spec.legacy_client is not None:
            client.upsert_team(spec.legacy_client.team, legacy=True)

        for team in spec.teams:
            for user_id in team.users:
                user = client.ensure_user(user_id)
                client.assign_exclusive_managed_team(user_id, team.team_id, user)

        if legacy_key is not None:
            assert spec.legacy_client is not None
            if len(legacy_key) < 16:
                print(
                    "registering a short legacy key; the LiteLLM legacy service must temporarily "
                    f"set MINIMUM_CUSTOM_KEY_LENGTH={len(legacy_key)}"
                )
            client.ensure_legacy_virtual_key(spec.legacy_client, legacy_key)
    except (
        OSError,
        ValueError,
        json.JSONDecodeError,
        LiteLLMApiError,
        RuntimeError,
    ) as error:
        print(str(error), file=sys.stderr)
        return 1

    print("Team provisioning complete; no per-user Virtual Keys were created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
