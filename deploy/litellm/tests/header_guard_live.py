"""Live header-guard checks with valid JWT and Virtual Key credentials."""

import http.client
import json
import argparse
from pathlib import Path
from live_urls import model_service_url


ROOT = Path(__file__).resolve().parent / 'integration'
parser = argparse.ArgumentParser()
parser.add_argument('--model-url', default='http://127.0.0.1:9108')
args = parser.parse_args()
from urllib.parse import urlsplit
endpoint = urlsplit(model_service_url(args.model_url))
if endpoint.scheme not in ('http', 'https') or not endpoint.hostname or endpoint.username or endpoint.password:
    raise SystemExit('Invalid model URL')
login = json.loads((ROOT / 'state/login.json')
                   .read_text(encoding='utf-8'))
issuer = http.client.HTTPConnection('127.0.0.1', 9110, timeout=15)
issuer.request('POST', '/api/litellm/mtoken2jwt', json.dumps({
    'mtoken': login['mtoken'], 'deviceId': 'header-guard-test',
}), {'Content-Type': 'application/json'})
response = issuer.getresponse()
assert response.status == 200
token = json.loads(response.read())['access_token']
issuer.close()
key = (ROOT / 'state/development-api-key.txt').read_text(encoding='utf-8').strip()
account = ('X-User-Account', login['X-User-Account'])
cookie = ('X-Cookie', login['X-Cookie'])
cases = [
    ('valid', [account, cookie], 200, None),
    ('both_missing', [], 400, 'REQ-1042'),
    ('account_missing', [cookie], 400, 'REQ-1042'),
    ('account_empty', [('X-User-Account', ''), cookie], 400, 'REQ-1042'),
    ('account_too_short', [('X-User-Account', 's1234567'), cookie], 400, 'REQ-1042'),
    ('account_too_long', [('X-User-Account', 's123456789012'), cookie], 400, 'REQ-1042'),
    ('account_digit_prefix', [('X-User-Account', '130023758'), cookie], 400, 'REQ-1042'),
    ('account_invalid_suffix', [('X-User-Account', 's3002375x'), cookie], 400, 'REQ-1042'),
    ('account_duplicate', [account, ('x-user-account', account[1]), cookie], 400, 'REQ-1042'),
    ('cookie_missing', [account], 400, 'REQ-2071'),
    ('cookie_empty', [account, ('X-Cookie', '')], 400, 'REQ-2071'),
    ('cookie_not_pair', [account, ('X-Cookie', 'invalid-cookie')], 400, 'REQ-2071'),
    ('cookie_invalid_name', [account, ('X-Cookie', 'bad name=value')], 400, 'REQ-2071'),
    ('cookie_invalid_value', [account, ('X-Cookie', 'session=bad value')], 400, 'REQ-2071'),
    ('cookie_duplicate', [account, cookie, ('x-cookie', cookie[1])], 400, 'REQ-2071'),
]
body = json.dumps({'model': 'auth-test-model',
                   'messages': [{'role': 'user', 'content': 'header guard test'}]}).encode()

for mode, credential in [('JWT', token), ('VirtualKey', key)]:
    for name, headers, expected_status, expected_code in cases:
        connection = (http.client.HTTPSConnection if endpoint.scheme == 'https' else http.client.HTTPConnection)(endpoint.hostname, endpoint.port, timeout=20)
        try:
            connection.putrequest('POST', endpoint.path + '/v1/chat/completions')
            connection.putheader('Authorization', 'Bearer ' + credential)
            connection.putheader('Content-Type', 'application/json')
            connection.putheader('Content-Length', str(len(body)))
            for header, value in headers:
                connection.putheader(header, value)
            connection.endheaders(body)
            response = connection.getresponse()
            data = json.loads(response.read())
            code = data.get('error', {}).get('code')
            assert response.status == expected_status, f'{mode}/{name}: HTTP {response.status}'
            assert code == expected_code, f'{mode}/{name}: code={code}'
            if expected_code:
                assert response.getheader('x-request-id')
                assert data['error']['message'] == 'Request validation failed'
            else:
                assert data['choices'][0]['message']['content'] == 'JWT integration test passed.'
            print(f'PASS {mode}/{name}: HTTP {response.status}, code={code or "none"}')
        finally:
            connection.close()

print(f'PASS: {len(cases) * 2} live checks')
