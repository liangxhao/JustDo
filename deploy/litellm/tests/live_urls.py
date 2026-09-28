"""Shared URL rules for live tests behind optional proxy prefixes."""

from urllib.parse import urlsplit, urlunsplit


def model_service_url(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Invalid model URL')
    path = parsed.path.rstrip('/')
    if path.lower().endswith('/v1'):
        path = path[:-3]
    return urlunsplit(parsed._replace(path=path))
