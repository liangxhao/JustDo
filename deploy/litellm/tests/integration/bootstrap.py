"""Provision local test access once; never renew existing keys or overwrite Team policy."""

import hashlib
import json
import os
import secrets
import urllib.parse
import urllib.request
from pathlib import Path


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
headers = {'Authorization': 'Bearer ' + os.environ['LITELLM_MASTER_KEY'],
           'Content-Type': 'application/json'}


def request(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    with opener.open(urllib.request.Request('http://jwt:4000' + path,
                     headers=headers, data=data), timeout=30) as response:
        return json.load(response)


state = Path('/state')
state.mkdir(exist_ok=True)
key_file = state / 'development-api-key.txt'
marker = state / 'initialized.json'
if marker.exists() and not key_file.exists():
    raise SystemExit('Test key file is missing; restore state alongside the database.')
if not key_file.exists():
    with key_file.open('x', encoding='utf-8') as target:
        target.write('sk-' + secrets.token_hex(32))

key = key_file.read_text(encoding='utf-8').strip()
if not marker.exists():
    team = request('/team/info?team_id=standard')['team_info']
    if not team.get('models'):
        request('/team/update', {'team_id': 'standard', 'models': ['auth-test-model']})

    query = urllib.parse.urlencode({'key_hash': hashlib.sha256(key.encode()).hexdigest(),
                                    'return_full_object': 'true'})
    existing = request('/key/list?' + query).get('keys', [])
    if not existing:
        result = request('/key/generate', {'key': key, 'key_alias': 'local-auth-test',
            'team_id': 'standard', 'models': ['auth-test-model'], 'duration': '30d'})
        expiry = result.get('expires')
    else:
        expiry = existing[0].get('expires')
    marker.write_text(json.dumps({'expires': expiry}), encoding='utf-8')

print('Test access initialized. Key is in state/development-api-key.txt; existing policy and expiry preserved.')
