import { expect, test } from 'vitest';
const {
  __testing: { transform, MARKER },
} = require('../../../../scripts/patches/v2026.9.8/015-trusted-local-file-media.cjs');
// 9.8 moved the HTTP disposition implementation into an imported module. The
// attachment owner must still receive the MIME fallback without that function.
const attachmentOwner = `
import { n as buildManagedMediaContentDisposition } from './assistant-media-content-disposition.mjs';
const MANAGED_DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/msword"
]);
function resolveManagedMediaKind(mime) { return MANAGED_DOCUMENT_MIME_TYPES.has(mime) ? "document" : null; }
function createManagedOutgoingMediaBlocks(params) {
  const item = params.item;
  const media = params.media;
  const localPath = resolveLocalMediaPath(item.url);
  const contentType = media.contentType ?? item.mimeType;
  const kind = resolveManagedMediaKind(contentType);
  if (!kind) throw new Error("Managed media attachment has an unsupported content type");
  return { kind, contentType };
}
`;

test('patches the split native attachment owner and remains exactly idempotent', () => {
  const patched = transform(attachmentOwner, 'dist/managed-image-attachments.mjs');
  expect(patched).toContain(MARKER);
  expect(transform(patched, 'dist/managed-image-attachments.mjs')).toBe(patched);
  expect(patched).toContain('import { n as buildManagedMediaContentDisposition }');
  expect(() =>
    transform(patched.replaceAll('V2026_9_8', 'V2026_9_6'), 'dist/managed-image-attachments.mjs'),
  ).toThrow();
});

test('accepts undetectable MIME only for trusted local paths', () => {
  const source = transform(attachmentOwner, 'dist/managed-image-attachments.mjs').replace(
    /^import .*$/m,
    '',
  );
  const prepare = new Function(
    'resolveLocalMediaPath',
    'normalizeMimeType',
    source + '\nreturn createManagedOutgoingMediaBlocks;',
  )(
    (url: string) => (url.startsWith('C:/') ? url : undefined),
    (mime: string) => mime,
  );
  expect(prepare({ item: { url: 'C:/report.bin', trustedLocal: true }, media: {} })).toEqual({
    kind: 'document',
    contentType: 'application/octet-stream',
  });
  for (const item of [
    { url: 'C:/report.bin', trustedLocal: false },
    { url: 'https://example.com/report.bin', trustedLocal: true },
  ]) {
    expect(() => prepare({ item, media: {} })).toThrow('unsupported content type');
    expect(() => prepare({ item, media: { contentType: 'application/octet-stream' } })).toThrow(
      'unsupported content type',
    );
  }
});
