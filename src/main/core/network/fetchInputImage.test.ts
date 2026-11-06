import { beforeEach, expect, it, vi } from 'vitest';

import { fetchInputImage } from './fetchInputImage';
import { mainProcessFetch } from './mainProcessFetch';

vi.mock('./mainProcessFetch', () => ({ mainProcessFetch: vi.fn() }));
beforeEach(() => vi.mocked(mainProcessFetch).mockReset());

it('fetches explicit intranet addresses through the existing transport without credentials or redirects', async () => {
  vi.mocked(mainProcessFetch).mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }));
  await expect(fetchInputImage('http://10.1.2.3/image', { maxBytes: 10 })).resolves.toEqual({ bytes: Buffer.from([1, 2]), mimeType: 'image/png' });
  expect(mainProcessFetch).toHaveBeenCalledWith('http://10.1.2.3/image', expect.objectContaining({
    method: 'GET', credentials: 'omit', redirect: 'error', headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp' },
  }), { maxResponseBytes: 10 });
});

it.each(['http://127.0.0.1/x', 'http://169.254.169.254/x', 'https://8.8.8.8/x', 'http://internal.example/x',
  'http://user:password@10.1.1.1/x', 'file:///image.png', 'http://[::1]/x', 'http://[::ffff:10.0.0.1]/x'])
('rejects URLs outside the explicit host policy: %s', async url => {
  await expect(fetchInputImage(url, { maxBytes: 10 })).rejects.toThrow();
  expect(mainProcessFetch).not.toHaveBeenCalled();
});

it('rejects redirect responses, unsupported content types and oversized bodies', async () => {
  vi.mocked(mainProcessFetch).mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'http://8.8.8.8' } }));
  await expect(fetchInputImage('http://192.168.1.1/x', { maxBytes: 10 })).rejects.toThrow();
  vi.mocked(mainProcessFetch).mockResolvedValueOnce(new Response('html', { headers: { 'content-type': 'text/html' } }));
  await expect(fetchInputImage('http://172.16.1.1/x', { maxBytes: 10 })).rejects.toThrow();
  vi.mocked(mainProcessFetch).mockResolvedValueOnce(new Response(new Uint8Array(11), { headers: { 'content-type': 'image/webp' } }));
  await expect(fetchInputImage('http://[fd00::1]/x', { maxBytes: 10 })).rejects.toThrow('size limit');
});
