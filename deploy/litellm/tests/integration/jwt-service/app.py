"""Local RS256 issuer for integration testing, not a production login service."""

import hashlib
import json
import os
import re
import secrets
import time
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, HTTPException, Response
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, Field, ConfigDict


DATA = Path(os.environ.get('JWT_DATA_DIR', '/data'))
DATA.mkdir(parents=True, exist_ok=True)
KEY_PATH = DATA / 'private.pem'

if not KEY_PATH.exists():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    encoded = key.private_bytes(serialization.Encoding.PEM,
                                serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption())
    with KEY_PATH.open('xb') as target:
        os.chmod(KEY_PATH, 0o600)
        target.write(encoded)

PRIVATE_KEY = serialization.load_pem_private_key(KEY_PATH.read_bytes(), password=None)
PUBLIC_JWK = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(PRIVATE_KEY.public_key()))
KID = hashlib.sha256(PRIVATE_KEY.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).hexdigest()[:24]
PUBLIC_JWK.update(kid=KID, use='sig', alg='RS256')
ISSUER = os.environ.get('JWT_ISSUER', 'http://localhost:9110')
AUDIENCE = 'model-service'
USERS_FILE = Path(os.environ.get('JWT_USERS_FILE', '/app/users.json'))
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class Exchange(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mtoken: str = Field(min_length=1, max_length=32768)
    deviceId: str = Field(min_length=1, max_length=256)
    clientIp: str | None = Field(default=None, max_length=64)


@app.exception_handler(RequestValidationError)
async def invalid_request(request, exc):
    # Do not echo invalid inputs, which can contain credentials.
    from fastapi.responses import JSONResponse
    return JSONResponse({'detail': 'Invalid exchange request'}, status_code=400,
                        headers={'Cache-Control': 'no-store'})


@app.get('/health')
def health():
    return {'status': 'ok'}


@app.get('/.well-known/jwks.json')
def jwks():
    return {'keys': [PUBLIC_JWK]}


@app.post('/api/litellm/mtoken2jwt')
def exchange(body: Exchange, response: Response):
    digest = hashlib.sha256(body.mtoken.encode()).hexdigest()
    users = json.loads(USERS_FILE.read_text(encoding='utf-8'))
    uid = next((item['uid'] for item in users
                if secrets.compare_digest(item['mtoken_sha256'], digest)), None)
    if uid is None or not re.fullmatch(r'[A-Za-z][A-Za-z0-9]{2,5}[0-9]{6}', uid):
        raise HTTPException(401, 'Invalid test credential', headers={'Cache-Control': 'no-store'})

    now = int(time.time())
    token = jwt.encode({'iss': ISSUER, 'aud': AUDIENCE, 'sub': uid,
                        'iat': now, 'exp': now + 300, 'jti': secrets.token_hex(16)},
                       PRIVATE_KEY, algorithm='RS256', headers={'kid': KID})
    response.headers['Cache-Control'] = 'no-store'
    return {'access_token': token, 'token_type': 'Bearer', 'expires_in': 300, 'uid': uid}
