"""Activity payload validation and pure state aggregation."""
import json
import math
import re
from uuid import UUID


MAX_BODY_BYTES = 8192
MAX_METADATA_DEPTH = 6
MAX_METADATA_NODES = 256
MAX_METADATA_KEYS = 128
MAX_METADATA_KEY_LENGTH = 128
MAX_METADATA_STRING_LENGTH = 2048
EVENT_TYPE_PATTERN = re.compile(r'[a-z][a-z0-9._-]{0,63}\Z')
_CREDENTIAL_KEYS = frozenset({
    'authorization', 'proxyauthorization', 'cookie', 'cookies', 'setcookie', 'xcookie',
    'password', 'passwd', 'pwd', 'apikey', 'accesskey', 'secretkey', 'clientsecret',
    'accesstoken', 'refreshtoken', 'idtoken', 'mtoken', 'token', 'jwt', 'xaccessjwt',
    'secret', 'credential', 'credentials', 'privatekey',
})


def _validate_metadata(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid metadata')
    pending = [(value, 0)]
    nodes = 0
    keys = 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if depth > MAX_METADATA_DEPTH or nodes > MAX_METADATA_NODES:
            raise ValueError('Metadata is too complex')
        if item is None or isinstance(item, (bool, int)):
            continue
        if isinstance(item, float):
            if not math.isfinite(item):
                raise ValueError('Invalid metadata number')
            continue
        if isinstance(item, str):
            if '\x00' in item or len(item) > MAX_METADATA_STRING_LENGTH:
                raise ValueError('Invalid metadata string')
            item.encode('utf-8')
            continue
        if isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
            continue
        if not isinstance(item, dict):
            raise ValueError('Invalid metadata value')
        keys += len(item)
        if keys > MAX_METADATA_KEYS:
            raise ValueError('Too many metadata keys')
        for key, child in item.items():
            if not isinstance(key, str) or not key or '\x00' in key or len(key) > MAX_METADATA_KEY_LENGTH:
                raise ValueError('Invalid metadata key')
            key.encode('utf-8')
            if re.sub(r'[^a-z0-9]', '', key.lower()) in _CREDENTIAL_KEYS:
                raise ValueError('Credentials are not accepted in metadata')
            pending.append((child, depth + 1))


def merge_activity(metadata, event, now):
    event_id, _, event_type, supplied = event
    if not isinstance(metadata, dict):
        raise ValueError('Stored user metadata is not an object')
    metadata = dict(metadata)
    stored_activity = metadata.get('user_activity')
    activity = dict(stored_activity) if isinstance(stored_activity, dict) else {}
    stored_seen = activity.get('recent_event_ids')
    seen = [item for item in stored_seen if isinstance(item, str)][-256:] if isinstance(stored_seen, list) else []
    duplicate = str(event_id) in seen

    timestamp = now.isoformat()
    day = timestamp[:10]
    stored_days = activity.get('days')
    days = {key: dict(value) for key, value in stored_days.items()
            if isinstance(key, str) and isinstance(value, dict)} if isinstance(stored_days, dict) else {}
    today = dict(days.get(day) or {'first_seen_at': timestamp, 'start_count': 0})
    count = today.get('start_count')
    today['start_count'] = count if type(count) is int and count >= 0 else 0
    today['last_seen_at'] = timestamp

    # Retries still prove current activity, but must not count another start/login.
    if event_type == 'startup' and not duplicate:
        today['start_count'] += 1
        activity['last_started_at'] = timestamp
    if event_type == 'login' and not duplicate:
        activity['last_login_reported_at'] = timestamp
    days[day] = today
    if not duplicate:
        activity['latest_event_type'] = event_type
        activity['metadata'] = json.loads(supplied)
    activity.update(
        last_seen_at=timestamp,
        days={k: days[k] for k in sorted(days)[-90:]},
        recent_event_ids=(seen if duplicate else seen + [str(event_id)])[-256:],
    )
    metadata['user_activity'] = activity
    return metadata


def validate_event(value):
    if not isinstance(value, dict):
        raise ValueError('Expected an object')
    if set(value) - {'event_id', 'user_id', 'event_type', 'metadata'}:
        raise ValueError('Unsupported activity fields')

    event_id = UUID(value['event_id'])
    user_id = value['user_id']
    if not isinstance(user_id, str) or not user_id.strip() or len(user_id) > 512:
        raise ValueError('Invalid user_id')

    event_type = value['event_type']
    if not isinstance(event_type, str) or not EVENT_TYPE_PATTERN.fullmatch(event_type):
        raise ValueError('Invalid event_type')

    metadata = value.get('metadata', {})
    _validate_metadata(metadata)
    return event_id, user_id.strip(), event_type, json.dumps(metadata, allow_nan=False)
