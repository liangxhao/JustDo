from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import provision_groups
import pytest
from provision_groups import (
    LegacyClientSpec,
    LiteLLMAdminClient,
    TeamSpec,
    _hash_token,
    load_provisioning_spec,
    load_team_specs,
)


def write_config(tmp_path, teams, *, legacy_client=None):
    config_path = tmp_path / "groups.json"
    payload = {"teams": teams}
    if legacy_client is not None:
        payload["legacy_client"] = legacy_client
    config_path.write_text(json.dumps(payload), encoding="utf-8")
    return config_path


def legacy_spec() -> LegacyClientSpec:
    return LegacyClientSpec(
        team=TeamSpec("legacy", "Legacy", ("all-proxy-models",), ()),
        key_alias="legacy-key",
    )


def test_load_team_specs_rejects_a_user_in_two_groups(tmp_path):
    config_path = write_config(
        tmp_path,
        [
            {
                "team_id": "team-a",
                "team_alias": "A",
                "models": ["model-a"],
                "users": ["user-001"],
            },
            {
                "team_id": "team-b",
                "team_alias": "B",
                "models": ["model-b"],
                "users": ["user-001"],
            },
        ],
    )

    with pytest.raises(ValueError, match="exactly one"):
        load_team_specs(config_path)


def test_load_team_specs_requires_an_explicit_model_allowlist(tmp_path):
    config_path = write_config(
        tmp_path,
        [
            {
                "team_id": "team-a",
                "team_alias": "A",
                "models": [],
                "users": ["user-001"],
            }
        ],
    )

    with pytest.raises(ValueError, match="models must not be empty"):
        load_team_specs(config_path)


def test_load_provisioning_spec_parses_persistent_teams_and_legacy_window(tmp_path):
    config_path = write_config(
        tmp_path,
        [
            {
                "team_id": "team-a",
                "team_alias": "A",
                "models": ["model-a"],
                "users": ["user-001"],
                "max_budget": 10,
                "budget_duration": "30d",
                "blocked": False,
            }
        ],
        legacy_client={
            "team_id": "legacy",
            "team_alias": "Legacy",
            "models": ["all-proxy-models"],
            "key_alias": "legacy-key",
            "rpm_limit": 20,
        },
    )

    spec = load_provisioning_spec(config_path)

    assert spec.teams[0].max_budget == 10
    assert spec.teams[0].budget_duration == "30d"
    assert spec.teams[0].blocked is False
    assert spec.legacy_client == LegacyClientSpec(
        team=TeamSpec(
            team_id="legacy",
            team_alias="Legacy",
            models=("all-proxy-models",),
            users=(),
            rpm_limit=20,
        ),
        key_alias="legacy-key",
    )


def test_team_update_preserves_metadata_and_marks_justdo_ownership():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client.get_team = Mock(
        return_value={
            "team_info": {
                "metadata": {
                    "cost_center": "research",
                    "justdo_legacy_clients": True,
                }
            }
        }
    )
    client.request = Mock(return_value={})

    client.upsert_team(
        TeamSpec(
            team_id="target-managed",
            team_alias="Target",
            models=("model-a",),
            users=("user-001",),
        )
    )

    client.request.assert_called_once_with(
        "POST",
        "/team/update",
        {
            "team_id": "target-managed",
            "team_alias": "Target",
            "models": ["model-a"],
            "metadata": {"cost_center": "research", "justdo_managed": True},
        },
    )


def test_user_creation_does_not_create_a_virtual_key():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client.get_user = Mock(
        side_effect=[None, {"user_info": {"user_id": "user-001", "teams": []}}]
    )
    client.request = Mock(return_value={})

    result = client.ensure_user("user-001")

    client.request.assert_called_once_with(
        "POST",
        "/user/new",
        {
            "user_id": "user-001",
            "user_role": "internal_user",
            "models": [],
            "auto_create_key": False,
        },
    )
    assert result["user_info"]["user_id"] == "user-001"


def test_assignment_removes_only_other_justdo_managed_teams():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client.request = Mock(return_value={})
    client.team_is_managed = Mock(side_effect=lambda team_id: team_id == "old-managed")

    client.assign_exclusive_managed_team(
        "user-001",
        "target-managed",
        {"user_info": {"teams": ["unrelated", "old-managed"]}},
    )

    assert client.request.call_args_list == [
        (
            (
                "POST",
                "/team/member_delete",
                {"team_id": "old-managed", "user_id": "user-001"},
            ),
            {},
        ),
        (
            (
                "POST",
                "/team/member_add",
                {
                    "team_id": "target-managed",
                    "member": {"role": "user", "user_id": "user-001"},
                },
            ),
            {},
        ),
    ]


def test_assignment_is_idempotent_when_target_membership_exists():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client.request = Mock(return_value={})
    client.team_is_managed = Mock(return_value=False)

    client.assign_exclusive_managed_team(
        "user-001",
        "target-managed",
        {"user_info": {"teams": ["target-managed"]}},
    )

    client.request.assert_not_called()


def test_legacy_virtual_key_is_the_only_generated_key_and_expires_in_30_days():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client._get_single_key = Mock(return_value=None)
    client.request = Mock(return_value={})

    client.ensure_legacy_virtual_key(legacy_spec(), "sk-old-client-key")

    client.request.assert_called_once_with(
        "POST",
        "/key/generate",
        {
            "key": "sk-old-client-key",
            "key_alias": "legacy-key",
            "team_id": "legacy",
            "models": ["all-team-models"],
            "allowed_routes": ["llm_api_routes", "/models", "/v1/models"],
            "duration": "30d",
            "metadata": {
                "justdo_managed": True,
                "justdo_legacy_clients": True,
                "justdo_legacy_expires_after": "30d",
            },
        },
    )


def test_existing_legacy_key_without_expiry_gets_one_but_is_not_rotated():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    old_key = "sk-old-client-key"
    client._get_single_key = Mock(
        return_value={
            "token": _hash_token(old_key),
            "expires": None,
            "metadata": {"existing": True},
        }
    )
    client.request = Mock(return_value={})

    client.ensure_legacy_virtual_key(legacy_spec(), old_key)

    payload = client.request.call_args.args[2]
    assert payload["duration"] == "30d"
    assert payload["allowed_routes"] == ["llm_api_routes", "/models", "/v1/models"]
    assert payload["metadata"]["existing"] is True
    assert "key" not in payload


def test_existing_legacy_key_with_valid_expiry_is_never_extended():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    old_key = "sk-old-client-key"
    client._get_single_key = Mock(
        return_value={
            "token": _hash_token(old_key),
            "expires": (datetime.now(timezone.utc) + timedelta(days=20)).isoformat(),
            "metadata": {},
        }
    )
    client.request = Mock(return_value={})

    client.ensure_legacy_virtual_key(legacy_spec(), old_key)

    assert "duration" not in client.request.call_args.args[2]


@pytest.mark.parametrize(
    ("expiry", "message"),
    [
        (timedelta(minutes=-1), "already expired"),
        (timedelta(days=31), "exceeds the 30-day"),
    ],
)
def test_existing_legacy_key_cannot_be_renewed_beyond_the_window(expiry, message):
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    old_key = "sk-old-client-key"
    client._get_single_key = Mock(
        return_value={
            "token": _hash_token(old_key),
            "expires": (datetime.now(timezone.utc) + expiry).isoformat(),
        }
    )

    with pytest.raises(RuntimeError, match=message):
        client.ensure_legacy_virtual_key(legacy_spec(), old_key)


def test_existing_legacy_alias_must_match_the_old_plaintext_key():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")
    client._get_single_key = Mock(
        return_value={
            "token": _hash_token("sk-another-client-key"),
            "expires": (datetime.now(timezone.utc) + timedelta(days=20)).isoformat(),
        }
    )

    with pytest.raises(RuntimeError, match="different token"):
        client.ensure_legacy_virtual_key(legacy_spec(), "sk-old-client-key")


def test_legacy_virtual_key_cannot_be_ambiguous_with_a_jwt():
    client = LiteLLMAdminClient("http://litellm.test", "server-master-key")

    with pytest.raises(ValueError, match="must not have JWT shape"):
        client.ensure_legacy_virtual_key(legacy_spec(), "sk-old.payload.signature")


def test_main_provisions_users_without_keys_then_registers_legacy_key_last(
    tmp_path, monkeypatch
):
    config_path = write_config(
        tmp_path,
        [
            {
                "team_id": "team-a",
                "team_alias": "A",
                "models": ["model-a"],
                "users": ["user-001"],
            }
        ],
        legacy_client={
            "team_id": "legacy",
            "team_alias": "Legacy",
            "models": ["all-proxy-models"],
        },
    )
    calls = []

    class FakeClient:
        def __init__(self, base_url, master_key):
            calls.append(("init", base_url, master_key))

        def upsert_team(self, team, *, legacy=False):
            calls.append(("team", team.team_id, legacy))

        def ensure_user(self, user_id):
            calls.append(("user", user_id))
            return {"user_info": {"teams": []}}

        def assign_exclusive_managed_team(self, user_id, team_id, user):
            calls.append(("membership", user_id, team_id))

        def ensure_legacy_virtual_key(self, legacy, virtual_key):
            calls.append(("legacy_key", legacy.team.team_id, virtual_key))

    monkeypatch.setattr(provision_groups, "LiteLLMAdminClient", FakeClient)
    monkeypatch.setenv("LITELLM_MASTER_KEY", "server-master-key")
    monkeypatch.setenv("LEGACY_KEY", "sk-old-client-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "provision_groups.py",
            str(config_path),
            "--legacy-key-env",
            "LEGACY_KEY",
        ],
    )

    assert provision_groups.main() == 0
    assert calls[-1] == ("legacy_key", "legacy", "sk-old-client-key")
    assert all(call[0] != "user_key" for call in calls)


def test_main_rejects_using_the_master_key_as_the_legacy_virtual_key(
    tmp_path, monkeypatch, capsys
):
    config_path = write_config(
        tmp_path,
        [
            {
                "team_id": "team-a",
                "team_alias": "A",
                "models": ["model-a"],
                "users": ["user-001"],
            }
        ],
        legacy_client={
            "team_id": "legacy",
            "team_alias": "Legacy",
            "models": ["all-proxy-models"],
        },
    )
    monkeypatch.setenv("LITELLM_MASTER_KEY", "sk-old-client-key")
    monkeypatch.setenv("LEGACY_KEY", "sk-old-client-key")
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "provision_groups.py",
            str(config_path),
            "--legacy-key-env",
            "LEGACY_KEY",
        ],
    )
    assert provision_groups.main() == 1
    assert "still the LiteLLM master key" in capsys.readouterr().err
