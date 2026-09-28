"""Exercise running issuer and LiteLLM without printing credentials."""

import base64
import json
import argparse
import urllib.error
import urllib.request
import urllib.parse
from pathlib import Path
from live_urls import model_service_url

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def request(url, payload=None, headers=None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body,
        headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with OPENER.open(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


ROOT = Path(__file__).resolve().parent / 'integration'
parser = argparse.ArgumentParser()
parser.add_argument('--model-url', default='http://127.0.0.1:9108')
args = parser.parse_args()
base_url = model_service_url(args.model_url)
parsed = urllib.parse.urlsplit(base_url)
if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
    raise SystemExit('Invalid model URL')
login = json.loads((ROOT / 'state/login.json').read_text(encoding='utf-8'))
endpoint = 'http://127.0.0.1:9110/api/litellm/mtoken2jwt'
status, result = request(endpoint, {'mtoken': login['mtoken'], 'deviceId': 'smoke-test'})
assert status == 200, f'Exchange failed: HTTP {status}'
assert result['uid'] == login['X-User-Account']
assert request(endpoint, {'mtoken': 'invalid-test-token', 'deviceId': 'smoke-test'})[0] == 401
print('PASS: token exchange and invalid mtoken rejection')

headers = {'Authorization': 'Bearer ' + result['access_token'],
           'X-User-Account': login['X-User-Account'], 'X-Cookie': login['X-Cookie']}
status, models = request(base_url + '/v1/models', headers=headers)
if status != 200:
    code = models.get('error', {}).get('code', 'unknown')
    raise SystemExit(f'LiteLLM authorization: HTTP {status}, code={code}. Configure default Team models in UI.')
print(f'PASS: LiteLLM JWT authorization; visible models={len(models.get("data", []))}')

if any(model['id'] == 'auth-test-model' for model in models.get('data', [])):
    status, completion = request(base_url + '/v1/chat/completions',
        {'model': 'auth-test-model', 'messages': [{'role': 'user', 'content': 'auth smoke test'}]}, headers)
    assert status == 200, f'Model call failed: HTTP {status}'
    assert completion['choices'][0]['message']['content'] == 'JWT integration test passed.'
    print('PASS: authenticated mock model completion')

status, denied = request(base_url + '/v1/chat/completions',
    {'model': 'auth-test-model', 'messages': [{'role': 'user', 'content': 'auth smoke test'}]},
    {'Authorization': headers['Authorization']})
assert status == 400, f'Missing headers returned unexpected HTTP {status}'
print('PASS: missing business headers rejected')

status, _ = request(base_url + '/v1/models', headers={
    'X-ACCESS-JWT': result['access_token'], 'X-User-Account': login['X-User-Account'],
    'X-Cookie': login['X-Cookie']})
assert status == 200
print('PASS: X-ACCESS-JWT authentication')

parts = result['access_token'].split('.')
payload = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
payload['sub'] = 's30023759'
parts[1] = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
headers['Authorization'] = 'Bearer ' + '.'.join(parts)
assert request(base_url + '/v1/models', headers=headers)[0] == 401
print('PASS: tampered JWT signature rejected')

headers['Authorization'] = 'Bearer invalid.invalid.invalid'
assert request(base_url + '/v1/models', headers=headers)[0] == 401
print('PASS: LiteLLM rejects invalid JWT')

key = (ROOT / 'state/development-api-key.txt').read_text().strip()
headers['Authorization'] = 'Bearer ' + key
status, completion = request(base_url + '/v1/chat/completions',
    {'model': 'auth-test-model', 'messages': [{'role': 'user', 'content': 'api key test'}]}, headers)
assert status == 200, f'Virtual Key call failed: HTTP {status}'
assert completion['choices'][0]['message']['content'] == 'JWT integration test passed.'
print('PASS: Virtual Key completion over configured model endpoint')

headers['Authorization'] = 'Bearer ' + result['access_token']
assert request(base_url + '/v1/models', headers=headers)[0] == 200
print('PASS: JWT model list over configured model endpoint')
