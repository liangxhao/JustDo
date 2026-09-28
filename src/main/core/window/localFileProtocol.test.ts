import { mkdtemp, rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), fetch: vi.fn() }));
vi.mock('electron', () => ({ protocol: { handle: mocks.handle }, net: { fetch: mocks.fetch } }));

import { registerLocalFileProtocol } from './localFileProtocol';

beforeEach(() => vi.clearAllMocks());

test.each([
  ['localfile:///E%3A/output/image%20%231.png', 'E:\\output\\image #1.png', true],
  ['localfile:///E:/%E5%9B%BE%E7%89%87/100%25%20%2523.png', 'E:\\图片\\100% %23.png', true],
  ['localfile://server/share/image%20%231.png', '\\\\server\\share\\image #1.png', true],
  ['localfile:///tmp/image%20%231.png', '/tmp/image #1.png', false],
] as const)('fetches the exact local path for %s', async (source, expectedPath, windows) => {
  const response = new Response('image');
  mocks.fetch.mockResolvedValue(response);
  registerLocalFileProtocol();
  expect(mocks.handle).toHaveBeenCalledWith('localfile', expect.any(Function));
  const handler = mocks.handle.mock.calls[0][1] as (request: { url: string }) => Promise<Response>;
  expect(await handler({ url: source })).toBe(response);
  const target = new URL(mocks.fetch.mock.calls[0][0] as string);
  expect(target.hash).toBe('');
  expect(target.search).toBe('');
  expect(fileURLToPath(target, { windows })).toBe(expectedPath);
});

test('serves exact byte ranges and rejects unsatisfiable ranges for local media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'justdo-media-test-'));
  try {
    const file = join(directory, 'sample #1.wav');
    await writeFile(file, '0123456789');
    mocks.fetch.mockImplementation(
      async () => new Response(null, { headers: { 'Content-Type': 'audio/wav' } }),
    );
    registerLocalFileProtocol();
    const handler = mocks.handle.mock.calls.find(call => call[0] === 'localmedia')![1];
    const url = pathToFileURL(file).href.replace('file:///', 'localmedia://local/');
    const response = await handler(new Request(url, { headers: { Range: 'bytes=2-5' } }));
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
    const tail = await handler(new Request(url, { headers: { Range: 'bytes=-3' } }));
    expect(await tail.text()).toBe('789');
    expect((await handler(new Request(url, { headers: { Range: 'bytes=20-' } }))).status).toBe(416);
    expect((await handler(new Request(url.replace('//local/', '//remote/')))).status).toBe(400);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
