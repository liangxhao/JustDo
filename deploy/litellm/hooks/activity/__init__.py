"""Activity hook factory: configuration and dependency assembly only."""
from ..jwt_auth.identity import authenticate_jwt
from collections.abc import Mapping
from starlette.types import ASGIApp

Environment = Mapping[str, str]
from .middleware import ActivityHook
from .store import PostgresStore


def wrap(app: ASGIApp, environ: Environment) -> ASGIApp:
    """Create this middleware without opening a database connection."""
    store = PostgresStore(environ['LITELLM_ACTIVITY_DATABASE_URL'])
    return ActivityHook(app, store, authenticate=authenticate_jwt)
