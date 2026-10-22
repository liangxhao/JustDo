/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import { i18nService } from '@/services/i18n';

import AttachmentCard from './AttachmentCard';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('opens the draft image in the sidebar without submitting or removing the attachment', () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const onRemove = vi.fn();
  const onSubmit = vi.fn();
  const attachment = {
    path: 'inline:photo',
    name: 'photo.png',
    isImage: true,
    dataUrl: 'data:image/png;base64,AA==',
  };
  render(
    <form onSubmit={onSubmit}>
      <AttachmentCard attachment={attachment} onRemove={onRemove} />
    </form>,
  );
  fireEvent.click(screen.getByRole('img'));
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: IMAGE_PREVIEW_EVENT,
      detail: { src: attachment.dataUrl, alt: attachment.name },
    }),
  );
  expect(onRemove).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();

  dispatch.mockClear();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkAttachmentRemove') }));
  expect(onRemove).toHaveBeenCalledWith(attachment.path);
  expect(dispatch).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

it('disables preview when the thumbnail fails to load', () => {
  render(
    <AttachmentCard
      attachment={{
        path: 'inline:photo',
        name: 'photo.png',
        isImage: true,
        dataUrl: 'data:image/png;base64,AA==',
      }}
      onRemove={vi.fn()}
    />,
  );
  fireEvent.error(screen.getByRole('img'));
  const preview = screen.getByRole('button', {
    name: `${i18nService.t('coworkImagePreviewTitle')}: photo.png`,
  }) as HTMLButtonElement;
  expect(preview.disabled).toBe(true);
});
