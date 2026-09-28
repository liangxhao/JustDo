"""Local integration issuer signing and rejection behavior."""

import hashlib
import importlib.util
import json
from pathlib import Path

import jwt
from fastapi.testclient import TestClient


def test_exchange_and_public_key(tmp_path, monkeypatch):
    monkeypatch.setenv('JWT_DATA_DIR', str(tmp_path / 'keys'))
    users = tmp_path / 'users.json'
    users.write_text(json.dumps([{'uid': 's30023758',
        'mtoken_sha256': hashlib.sha256(b'test-only').hexdigest()}]))
    monkeypatch.setenv('JWT_USERS_FILE', str(users))
    spec = importlib.util.spec_from_file_location('test_issuer_app',
        Path(__file__).resolve().parent / 'integration/jwt-service/app.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with TestClient(module.app) as client:
        response = client.post('/api/litellm/mtoken2jwt',
            json={'mtoken': 'test-only', 'deviceId': 'test-device'})
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-store'
        result = response.json()
        key_data = client.get('/.well-known/jwks.json').json()['keys'][0]
        assert 'd' not in key_data
        key = jwt.PyJWK.from_dict(key_data)
        claims = jwt.decode(result['access_token'], key.key, algorithms=['RS256'],
            audience='model-service', issuer=module.ISSUER)
        assert claims['sub'] == 's30023758'
        assert claims['exp'] - claims['iat'] == 300
        assert claims['jti']
        assert jwt.get_unverified_header(result['access_token'])['kid'] == key_data['kid']
        assert client.post('/api/litellm/mtoken2jwt',
            json={'mtoken': 'wrong', 'deviceId': 'test-device'}).status_code == 401
        invalid = client.post('/api/litellm/mtoken2jwt', json={'mtoken': 'test-only'})
        assert invalid.status_code == 400
        assert 'test-only' not in invalid.text
        second = client.post('/api/litellm/mtoken2jwt',
            json={'mtoken': 'test-only', 'deviceId': 'other', 'clientIp': '127.0.0.1'})
        assert second.json()['access_token'] != result['access_token']

    spec.loader.exec_module(module)
    assert module.KID == key_data['kid']
