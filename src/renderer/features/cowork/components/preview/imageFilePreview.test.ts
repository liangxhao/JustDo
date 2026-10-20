import { describe, expect, it } from 'vitest';

import { createImageFilePreview, isImageFilePath } from './imageFilePreview';

describe('sidebar image sources', () => {
  it('uses the same file identity for workspace paths and message image URLs', () => {
    const file = createImageFilePreview('E:\\工作 空间\\图 #1.png', '');
    expect(file?.src).toBe(
      'localfile:///E%3A/%E5%B7%A5%E4%BD%9C%20%E7%A9%BA%E9%97%B4/%E5%9B%BE%20%231.png',
    );
    expect(createImageFilePreview(file!.src, 'image')).toEqual(file);
    expect(file?.filePath).toBe('E:/工作 空间/图 #1.png');
  });

  it('resolves relative file paths against the workspace', () => {
    expect(createImageFilePreview('output/../图.png', '', 'E:\\workspace')?.filePath).toBe(
      'E:/workspace/图.png',
    );
    expect(createImageFilePreview('/tmp/image.png', '')?.filePath).toBe('/tmp/image.png');
  });

  it('accepts supported images but rejects executable sources and non-image data', () => {
    expect(isImageFilePath('photo.JPEG')).toBe(true);
    expect(isImageFilePath('photo.JFIF')).toBe(true);
    expect(isImageFilePath('animation.apng')).toBe(true);
    expect(isImageFilePath('photo.jpe')).toBe(true);
    expect(isImageFilePath('source.psd')).toBe(false);
    expect(isImageFilePath('document.pdf')).toBe(false);
    expect(createImageFilePreview('data:image/png;base64,AA==', '')?.label).toBe('');
    expect(createImageFilePreview('https://example.com/image.png', 'photo')?.label).toBe('photo');
    expect(createImageFilePreview('javascript:alert(1)', '')).toBeNull();
    expect(createImageFilePreview('data:text/html,hello', '')).toBeNull();
  });
});
