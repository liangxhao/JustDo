import { expect, it, vi } from 'vitest';

import { openSummaryResource } from './openSummaryResource';

function fixture() {
  return {
    isCurrent: vi.fn(() => true),
    resolveArtifact: vi.fn(),
    readAttachment: vi.fn(),
    openFile: vi.fn(),
    openImage: vi.fn(),
    openUrl: vi.fn(),
  };
}

it('opens an existing file through the normal preview entry without resolving or copying it', async () => {
  const navigation = fixture();
  expect(
    await openSummaryResource(
      {
        id: 'file',
        title: 'report.pdf',
        target: { kind: 'file', path: 'E:/project/report.pdf' },
      },
      navigation,
    ),
  ).toBe(true);
  expect(navigation.openFile).toHaveBeenCalledWith('E:/project/report.pdf');
  expect(navigation.resolveArtifact).not.toHaveBeenCalled();
  expect(navigation.readAttachment).not.toHaveBeenCalled();
});

it('resolves an artifact to its existing original file reference', async () => {
  const navigation = fixture();
  const target = { kind: 'artifact' as const, artifactId: 'one', assistantOnly: true };
  navigation.resolveArtifact.mockReturnValue({
    id: 'file',
    title: 'report.pdf',
    target: { kind: 'file', path: 'E:/project/report.pdf' },
  });
  expect(await openSummaryResource({ id: 'one', title: 'report.pdf', target }, navigation)).toBe(
    true,
  );
  expect(navigation.resolveArtifact).toHaveBeenCalledWith(target, 'report.pdf');
  expect(navigation.openFile).toHaveBeenCalledWith('E:/project/report.pdf');
});

it('directly previews a loaded inline image, without staging a file', async () => {
  const navigation = fixture();
  const target = { kind: 'attachment' as const, messageKey: 'entry-one', version: 1, index: 0 };
  navigation.readAttachment.mockReturnValue({
    url: 'data:image/png;base64,YQ==',
    label: 'image.png',
    mimeType: 'image/png',
  });
  expect(await openSummaryResource({ id: 'input', title: 'image.png', target }, navigation)).toBe(
    true,
  );
  expect(navigation.openImage).toHaveBeenCalledWith('data:image/png;base64,YQ==', 'image.png');
  expect(navigation.openFile).not.toHaveBeenCalled();
  expect(navigation.openUrl).not.toHaveBeenCalled();
});

it('keeps an opaque artifact or an inline document without an original file unopened', async () => {
  const navigation = fixture();
  expect(
    await openSummaryResource(
      {
        id: 'one',
        title: 'report.pdf',
        target: { kind: 'artifact', artifactId: 'one', assistantOnly: true },
      },
      navigation,
    ),
  ).toBe(false);
  navigation.readAttachment.mockReturnValue({
    url: 'data:application/pdf;base64,YQ==',
    label: 'report.pdf',
  });
  expect(
    await openSummaryResource(
      {
        id: 'input',
        title: 'report.pdf',
        target: { kind: 'attachment', messageKey: 'entry', version: 1, index: 0 },
      },
      navigation,
    ),
  ).toBe(false);
  expect(navigation.openFile).not.toHaveBeenCalled();
  expect(navigation.openUrl).not.toHaveBeenCalled();
});

it('does not navigate after a session switch while resolving an original', async () => {
  const navigation = fixture();
  navigation.resolveArtifact.mockImplementation(() => {
    navigation.isCurrent.mockReturnValue(false);
    return {
      id: 'file',
      title: 'report.pdf',
      target: { kind: 'file', path: 'E:/project/report.pdf' },
    };
  });
  expect(
    await openSummaryResource(
      {
        id: 'one',
        title: 'report.pdf',
        target: { kind: 'artifact', artifactId: 'one', assistantOnly: true },
      },
      navigation,
    ),
  ).toBe(false);
  expect(navigation.openFile).not.toHaveBeenCalled();
});

it('opens web references in the browser and remote images in the image preview', async () => {
  const navigation = fixture();
  expect(
    await openSummaryResource(
      { id: 'url', title: 'source', target: { kind: 'url', url: 'https://example.com' } },
      navigation,
    ),
  ).toBe(true);
  expect(navigation.openUrl).toHaveBeenCalledWith('https://example.com/');
  expect(
    await openSummaryResource(
      {
        id: 'image',
        title: 'image',
        mimeType: 'image/png',
        target: { kind: 'media', url: 'https://example.com/image.png' },
      },
      navigation,
    ),
  ).toBe(true);
  expect(navigation.openImage).toHaveBeenCalledWith('https://example.com/image.png', 'image');
});

it.each(['javascript:alert(1)', 'https://user:password@example.com/'])(
  'rejects an executable or credentialed URL: %s',
  async url => {
    const navigation = fixture();
    expect(
      await openSummaryResource(
        { id: 'url', title: 'source', target: { kind: 'url', url } },
        navigation,
      ),
    ).toBe(false);
    expect(navigation.openFile).not.toHaveBeenCalled();
    expect(navigation.openUrl).not.toHaveBeenCalled();
  },
);

it.each(['https://example.com/guide#installation', 'https://example.com/#/reports/42'])(
  'preserves the fragment when opening a web resource: %s',
  async url => {
    const navigation = fixture();
    expect(
      await openSummaryResource(
        { id: 'url', title: 'source', target: { kind: 'url', url } },
        navigation,
      ),
    ).toBe(true);
    expect(navigation.openUrl).toHaveBeenCalledWith(url);
  },
);
