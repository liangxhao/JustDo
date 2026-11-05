"""Stable JWT and managed-Team errors; messages never interpolate credentials."""
from enum import Enum

from litellm.proxy._types import ProxyException
from hooks.errors import ErrorResponse


class JwtFailure(Enum):
    CREDENTIALS = ('JWT-1001', 401, 'Authentication failed: JWT or required identity headers are missing or malformed')
    CONFLICT = ('JWT-1002', 401, 'Authentication failed: conflicting JWT credentials')
    HEADER = ('JWT-1003', 401, 'Authentication failed: JWT algorithm is not allowed or kid is missing')
    SIGNATURE = ('JWT-1004', 401, 'Authentication failed: JWT signature is invalid')
    EXPIRED = ('JWT-1005', 401, 'Authentication failed: JWT has expired')
    NOT_YET_VALID = ('JWT-1006', 401, 'Authentication failed: JWT is not yet valid or was issued in the future')
    ISSUER = ('JWT-1007', 401, 'Authentication failed: JWT issuer does not match')
    AUDIENCE = ('JWT-1008', 401, 'Authentication failed: JWT audience does not match')
    CLAIMS = ('JWT-1009', 401, 'Authentication failed: required JWT claims (sub, jti, iss, aud, iat, exp) are missing or invalid')
    TIMESTAMPS = ('JWT-1010', 401, 'Authentication failed: JWT iat and exp must be integer timestamps')
    LIFETIME = ('JWT-1011', 401, 'Authentication failed: JWT lifetime exceeds the configured maximum')
    ACCOUNT = ('JWT-1012', 401, 'Authentication failed: account header does not match JWT subject')
    INVALID = ('JWT-1013', 401, 'Authentication failed: JWT validation failed; token format or claims are invalid')
    SIGNING_KEY = ('JWT-1014', 401, 'Authentication failed: JWT signing key is not available')
    CONFIGURATION = ('JWT-1501', 503, 'JWT authentication is temporarily unavailable; contact the administrator')
    JWKS = ('JWT-1502', 503, 'JWT signing-key service is temporarily unavailable; retry later')
    INTERNAL = ('JWT-1503', 503, 'JWT authorization service is temporarily unavailable; retry later')
    USER = ('AUTH-2001', 403, 'Authorization failed: user is not provisioned in LiteLLM')
    TEAM = ('AUTH-2002', 403, 'Authorization failed: user must belong to exactly one active managed Team')
    MEMBERSHIP = ('AUTH-2003', 403, 'Authorization failed: active managed Team membership was not found')
    MODELS = ('AUTH-2004', 403, 'Authorization failed: active managed Team must have an explicit model list')
    BLOCKED = ('AUTH-2005', 403, 'Authorization failed: Team is blocked')
    DEFAULT_TEAM = ('AUTH-2006', 403, 'Default Team is unavailable')
    ROSTER = ('AUTH-2007', 403, 'Default Team roster is invalid')
    MEMBER_BUDGET = ('AUTH-2008', 403, 'Default member budget is invalid or unavailable')
    MEMBER_MODELS = ('AUTH-2009', 403, 'Default member models are invalid')
    ENROLLMENT = ('AUTH-2501', 503, 'Authorization failed: automatic enrollment unavailable')
    TEAM_LOOKUP = ('AUTH-2502', 503, 'Authorization failed: Team lookup unavailable')
    MEMBER_POLICY_LOOKUP = ('AUTH-2503', 503, 'Authorization failed: Team member policy lookup unavailable')


class JwtAuthError(ProxyException):
    def __init__(self, failure: JwtFailure):
        code, status, message = failure.value
        self.details = ErrorResponse(code, failure.name.lower(), message, status, 'auth_error')
        super().__init__(message=message, type='auth_error', param=None,
                         code=status, headers=self.details.headers, openai_code=code)

    def to_dict(self):
        return self.details.to_dict()
