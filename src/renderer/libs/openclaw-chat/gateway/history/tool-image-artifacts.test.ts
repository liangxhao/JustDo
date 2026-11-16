import { expect, test, vi } from 'vitest';

import { createToolImageArtifactReader } from './tool-image-artifacts';

const sessionKey = 'agent:main:fixture';
const image = { id: 'artifact_transcript_image_fixture', messageSeq: 2, mimeType: 'image/svg+xml' };
const response = {
  artifact: { ...image, type: 'image', sessionKey },
  encoding: 'base64',
  data: 'PHN2Zy8+',
};

test.each([
  { sessionKey: 'agent:main:other' },
  { messageSeq: 3 },
  { mimeType: 'text/html' },
])('rejects a mismatched image response %j', async artifact => {
  const request = vi.fn().mockResolvedValue({ ...response, artifact: { ...response.artifact, ...artifact } });
  const read = createToolImageArtifactReader({ request }, sessionKey, () => true);

  expect(await read(image, new AbortController().signal)).toBeNull();
});

test('ignores an image received after the read scope changes', async () => {
  let resolveResponse!: (result: typeof response) => void;
  const request = vi.fn().mockImplementation(() =>
    new Promise(resolve => { resolveResponse = resolve; }),
  );
  let current = true;
  const read = createToolImageArtifactReader({ request }, sessionKey, () => current);

  const pending = read(image, new AbortController().signal);
  await Promise.resolve();
  current = false;
  resolveResponse(response);

  expect(await pending).toBeNull();
});
