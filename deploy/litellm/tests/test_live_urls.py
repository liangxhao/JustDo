import pytest
from live_urls import model_service_url


@pytest.mark.parametrize('url', ['https://example.test/proxy', 'https://example.test/proxy/v1/', 'https://example.test/proxy/V1'])
def test_preserves_reverse_proxy_prefix(url):
    assert model_service_url(url) == 'https://example.test/proxy'


@pytest.mark.parametrize('url', ['file:///tmp/x', 'https://user:secret@example.test', 'https://example.test/?a=1'])
def test_rejects_invalid_targets(url):
    with pytest.raises(ValueError):
        model_service_url(url)
