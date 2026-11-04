import json
import unittest
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from hooks.activity.events import (
    MAX_METADATA_DEPTH,
    MAX_METADATA_KEYS,
    MAX_METADATA_KEY_LENGTH,
    MAX_METADATA_NODES,
    MAX_METADATA_STRING_LENGTH,
    merge_activity,
    validate_event,
)
from hooks.activity.store import validate_database_url


class ActivityStateTests(unittest.TestCase):
    def event(self, event_id=None, client_time='2026-09-22T12:00:00Z'):
        return validate_event({
            'event_id': event_id or str(uuid4()),
            'user_id': 'test',
            'event_type': 'startup',
            'metadata': {'clientTime': client_time},
        })

    def test_cross_day_retry_updates_presence_without_counting_another_start(self):
        first_time = datetime(2026, 9, 22, 12, tzinfo=timezone.utc)
        event = self.event()
        first = merge_activity({'other': True}, event, first_time)
        retry = self.event(str(event[0]), '2026-09-23T12:00:00Z')
        result = merge_activity(first, retry, first_time + timedelta(days=1))
        activity = result['user_activity']

        self.assertTrue(result['other'])
        self.assertEqual(activity['days']['2026-09-22']['start_count'], 1)
        self.assertEqual(activity['days']['2026-09-23']['start_count'], 0)
        self.assertEqual(activity['last_started_at'], first_time.isoformat())
        self.assertEqual(activity['last_seen_at'], (first_time + timedelta(days=1)).isoformat())
        self.assertEqual(activity['metadata']['clientTime'], '2026-09-22T12:00:00Z')
        self.assertEqual(len(activity['recent_event_ids']), 1)

    def test_same_day_retry_does_not_mutate_input_or_double_count(self):
        now = datetime(2026, 9, 22, tzinfo=timezone.utc)
        event = self.event()
        first = merge_activity({}, event, now)
        snapshot = json.dumps(first)
        result = merge_activity(first, event, now + timedelta(minutes=1))
        self.assertEqual(json.dumps(first), snapshot)
        self.assertEqual(result['user_activity']['days']['2026-09-22']['start_count'], 1)

    def test_retention_limits(self):
        state = {}
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for day in range(300):
            state = merge_activity(state, self.event(), now + timedelta(days=day))
        self.assertEqual(len(state['user_activity']['days']), 90)
        self.assertEqual(len(state['user_activity']['recent_event_ids']), 256)

    def test_rejects_unknown_envelope_fields(self):
        for field, value in (('total_tokens', 1234), ('session_count', 5), ('metrics', '{}')):
            event = {'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'heartbeat'}
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_event({**event, field: value})

    def test_accepts_future_event_types_and_nested_json_snapshots(self):
        metadata = {
            'clientTime': '2026-11-04T09:00:00Z',
            'dailyUsage': {'date': '2026-11-04', 'total_tokens': 1200, 'ratio': 0.5},
            'providers': [{'id': 'local-provider', 'input_tokens': 400, 'enabled': True}],
            'optional': None,
        }
        event = validate_event({'event_id': str(uuid4()), 'user_id': 'test',
                                'event_type': 'usage.snapshot-v2', 'metadata': metadata})
        result = merge_activity({}, event, datetime(2026, 11, 4, tzinfo=timezone.utc))
        self.assertEqual(result['user_activity']['metadata'], metadata)
        self.assertEqual(result['user_activity']['latest_event_type'], 'usage.snapshot-v2')
        self.assertNotIn('last_started_at', result['user_activity'])

    def test_custom_event_retry_does_not_accumulate_or_regress_latest_snapshot(self):
        now = datetime(2026, 11, 4, tzinfo=timezone.utc)
        first_event = validate_event({'event_id': str(uuid4()), 'user_id': 'test',
                                     'event_type': 'usage.snapshot', 'metadata': {'total_tokens': 12}})
        latest_event = validate_event({'event_id': str(uuid4()), 'user_id': 'test',
                                      'event_type': 'session.snapshot', 'metadata': {'total_tokens': 34}})
        first = merge_activity({}, first_event, now)
        latest = merge_activity(first, latest_event, now + timedelta(seconds=1))
        result = merge_activity(latest, first_event, now + timedelta(seconds=2))
        activity = result['user_activity']
        self.assertEqual(activity['metadata'], {'total_tokens': 34})
        self.assertEqual(activity['latest_event_type'], 'session.snapshot')
        self.assertEqual(activity['days']['2026-11-04']['start_count'], 0)
        self.assertEqual(activity['last_seen_at'], (now + timedelta(seconds=2)).isoformat())
        self.assertEqual(len(activity['recent_event_ids']), 2)

    def test_malformed_activity_slot_does_not_overwrite_root_permissions(self):
        root = {'user_activity': 'malformed', 'permissions': {'models': ['approved']}, 'max_budget': 12}
        event = validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'settings.snapshot',
                                'metadata': {'permissions': {'models': ['untrusted']}, 'max_budget': 999}})
        result = merge_activity(root, event, datetime(2026, 11, 4, tzinfo=timezone.utc))
        self.assertEqual(result['permissions'], root['permissions'])
        self.assertEqual(result['max_budget'], 12)
        self.assertEqual(result['user_activity']['metadata']['max_budget'], 999)
        self.assertEqual(root['user_activity'], 'malformed')

    def test_non_object_stored_metadata_is_not_replaced(self):
        with self.assertRaises(ValueError):
            merge_activity(['existing', 'data'], self.event(), datetime.now(timezone.utc))

    def test_rejects_credentials_at_any_metadata_depth(self):
        for key in ('Cookie', 'X-ACCESS-JWT', 'accessToken', 'api_key', 'private-key', 'password'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'profile.snapshot',
                                'metadata': {'nested': [{'other': {key: 'private'}}]}})

    def test_rejects_non_finite_json_numbers(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'usage.snapshot',
                                'metadata': {'nested': [value]}})

    def test_rejects_nul_in_nested_json_values_and_keys(self):
        for metadata in ({'nested': [{'value': 'invalid\x00text'}]}, {'nested': {'invalid\x00key': 'value'}}):
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'custom.event',
                                'metadata': metadata})
        metadata = {'字段': ['正常中文', 'é', '📝']}
        event = validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'custom.event',
                                'metadata': metadata})
        self.assertEqual(json.loads(event[3]), metadata)

    def test_metadata_structure_and_string_bounds(self):
        nested = None
        for _ in range(MAX_METADATA_DEPTH + 1):
            nested = {'next': nested}
        cases = (
            nested,
            {'nodes': [None] * MAX_METADATA_NODES},
            {str(index): index for index in range(MAX_METADATA_KEYS + 1)},
            {'x' * (MAX_METADATA_KEY_LENGTH + 1): 1},
            {'value': 'x' * (MAX_METADATA_STRING_LENGTH + 1)},
        )
        for metadata in cases:
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'custom.event',
                                'metadata': metadata})
        event = validate_event({'event_id': str(uuid4()), 'user_id': 'test', 'event_type': 'custom.event',
                                'metadata': {'value': 'x' * MAX_METADATA_STRING_LENGTH}})
        self.assertEqual(len(json.loads(event[3])['value']), MAX_METADATA_STRING_LENGTH)


class DatabaseUrlTests(unittest.TestCase):
    def test_accepts_postgres_options_without_rewriting_schema(self):
        uri = 'postgresql://user:secret@localhost/db?sslmode=require&search_path=public'
        self.assertEqual(validate_database_url(uri), uri)

    def test_rejects_prisma_options_without_leaking_credentials(self):
        for option in ('schema=public', 'connection_limit=5', 'pool_timeout=10'):
            with self.subTest(option=option):
                with self.assertRaises(ValueError) as error:
                    validate_database_url('postgresql://user:private-password@localhost/db?' + option)
                self.assertNotIn('private-password', str(error.exception))

    def test_rejects_invalid_uri(self):
        for uri in ('', 'https://localhost/db', 'postgresql://[broken'):
            with self.subTest(uri=uri), self.assertRaises(ValueError):
                validate_database_url(uri)
