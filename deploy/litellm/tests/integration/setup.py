"""Generate isolated local test configuration; never modify desktop login data."""

import hashlib
import json
import secrets
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    outputs = [root / '.env', root / 'config.yaml', root / 'state', root / 'jwt-service/users.json']
    if any(path.exists() for path in outputs):
        raise SystemExit('Existing test configuration found; refusing to overwrite it.')

    database = secrets.token_hex(24)
    settings = {
        'POSTGRES_PASSWORD': database,
        'DATABASE_URL': f'postgresql://litellm:{database}@db:5432/litellm',
        'LITELLM_ACTIVITY_DATABASE_URL': f'postgresql://litellm:{database}@db:5432/litellm',
        'REDIS_PASSWORD': secrets.token_hex(24),
        'LITELLM_MASTER_KEY': 'sk-' + secrets.token_hex(32),
        'LITELLM_SALT_KEY': secrets.token_hex(32),
        'UI_USERNAME': 'admin',
        'UI_PASSWORD': secrets.token_urlsafe(24),
        'LITELLM_JWT_ISSUER': 'http://localhost:9110',
        'LITELLM_JWT_AUDIENCE': 'model-service',
        'LITELLM_JWT_JWKS_URL': 'http://127.0.0.1:9110/.well-known/jwks.json',
        'LITELLM_JWT_ALGORITHMS': 'RS256',
        'LITELLM_JWT_MAX_LIFETIME_SECONDS': '300',
        'LITELLM_DEFAULT_TEAM_ID': 'standard',
        'MAX_STRING_LENGTH_PROMPT_IN_DB': '100000',
    }
    login = {'X-User-Account': 't12345678', 'X-Cookie': 'test_session=' + secrets.token_hex(16),
             'mtoken': secrets.token_urlsafe(48)}
    (root / 'state').mkdir()
    (root / 'state/login.json').write_text(json.dumps(login), encoding='utf-8')
    (root / 'jwt-service/users.json').write_text(json.dumps([{
        'uid': login['X-User-Account'],
        'mtoken_sha256': hashlib.sha256(login['mtoken'].encode()).hexdigest(),
    }]), encoding='utf-8')
    (root / '.env').write_text(''.join(f'{k}={v}\n' for k, v in settings.items()), encoding='utf-8')
    config = (root.parents[1] / 'docker/config.yaml').read_text(encoding='utf-8')
    mock = """model_list:
  - model_name: auth-test-model
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: mock-only-not-a-real-key
      mock_response: 'JWT integration test passed.'

"""
    (root / 'config.yaml').write_text(mock + config, encoding='utf-8')
    print('Test configuration generated; credentials are in .env and state/.')


if __name__ == '__main__':
    main()
