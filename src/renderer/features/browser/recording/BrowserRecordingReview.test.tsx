// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { BrowserRecordingReview } from './BrowserRecordingReview';

afterEach(cleanup);
it('explains a recorded scroll without exposing unlabeled coordinate values', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <BrowserRecordingReview
      draft={{
        id: 'r',
        sessionId: 's',
        profile: 'embedded',
        title: '',
        note: '',
        startedAt: 0,
        images: [],
        steps: [
          {
            id: 'scroll',
            pageId: 'p',
            at: 0,
            action: 'scroll',
            title: '',
            url: 'https://example.com/',
            value: '0,700',
          },
        ],
      }}
      onSave={() => {}}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('滚动到的位置')).toBeTruthy();
  expect(screen.getByText('横向 0 像素 · 纵向 700 像素')).toBeTruthy();
  expect(screen.queryByText('操作值')).toBeNull();
  expect(screen.queryByText('0,700')).toBeNull();
  const privacy = screen.getByRole('button', { name: '发送前检查' });
  const row = privacy.parentElement;
  expect(privacy.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(privacy);
  expect(privacy.getAttribute('aria-expanded')).toBe('true');
  expect(privacy.parentElement).toBe(row);
  const explanation = document.getElementById(privacy.getAttribute('aria-controls')!);
  expect(explanation?.hidden).toBe(false);
  expect(row?.contains(explanation)).toBe(false);
  fireEvent.click(privacy);
  expect(explanation?.hidden).toBe(true);
});
it('removes stale screenshots when an input value is edited and retains the step order', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  render(
    <BrowserRecordingReview
      draft={{
        id: 'r',
        sessionId: 's',
        profile: 'embedded',
        title: 'Orders',
        note: '',
        startedAt: 1,
        steps: [
          {
            id: '1',
            action: 'input',
            pageId: 'tab',
            at: 1,
            url: 'https://example.com/',
            title: '',
            value: '123',
            target: {
              tag: 'input',
              role: 'textbox',
              name: 'q',
              selector: 'input[name="q"]',
              html: '<input name="q" placeholder="Search">',
            },
            screenshotIssue: 'password',
          },
        ],
        images: [{ stepId: '1', dataUrl: 'data:image/png;base64,AA==', fileName: 'step.png' }],
      }}
      onSave={save}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText('Element details')).toBeTruthy();
  expect(screen.getByText('input[name="q"]')).toBeTruthy();
  expect(screen.getByText('<input name="q" placeholder="Search">')).toBeTruthy();
  expect(screen.getByText('input[name="q"]').closest('.recording-technical')?.tagName).toBe('DIV');
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const screenshot = screen.getByAltText('Step screenshot 1');
  fireEvent.click(screenshot);
  expect(dispatch).not.toHaveBeenCalled();
  fireEvent.doubleClick(screenshot);
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'cowork:preview-image',
      detail: { src: 'data:image/png;base64,AA==', alt: 'Step screenshot 1' },
    }),
  );
  dispatch.mockClear();
  expect(screen.queryByRole('button', { name: 'View full image' })).toBeNull();
  expect(screen.queryByText('Step screenshot')).toBeNull();
  fireEvent.keyDown(screenshot, { key: 'Enter' });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Input value 1')).toBeTruthy();
  dispatch.mockRestore();
  expect(screen.getByText('No screenshot: a visible password field is present.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Input value 1'), { target: { value: '456' } });
  fireEvent.click(screen.getByText('Save changes'));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      images: [],
      steps: [expect.objectContaining({ id: '1', value: '456' })],
    }),
  );
});

it('shows page info for navigation, element details for targets, and keeps deletion scoped', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  render(
    <BrowserRecordingReview
      draft={{
        id: 'r',
        sessionId: 's',
        profile: 'embedded',
        title: '',
        note: '',
        startedAt: 0,
        steps: [
          {
            id: 'nav',
            pageId: 'p',
            action: 'navigate',
            at: 0,
            title: '',
            url: 'https://example.com/?long=address',
          },
          {
            id: 'click',
            pageId: 'p',
            action: 'click',
            at: 1,
            title: 'Search',
            url: 'https://example.com/',
            target: {
              tag: 'button',
              role: 'button',
              name: 'Search',
              selector: '#search',
              html: '<button>Search</button>',
            },
          },
        ],
        images: [
          { stepId: 'nav', fileName: 'nav.jpg', dataUrl: 'data:image/jpeg;base64,AA==' },
          { stepId: 'click', fileName: 'click.jpg', dataUrl: 'data:image/jpeg;base64,AA==' },
        ],
      }}
      onSave={save}
      onClose={() => {}}
    />,
  );
  const steps = screen.getAllByRole('listitem');
  expect(within(steps[0]).queryByText('Element details')).toBeNull();
  expect(within(steps[0]).getByText('Page info')).toBeTruthy();
  expect(within(steps[0]).getByText('Page-level action, no associated HTML element')).toBeTruthy();
  expect(within(steps[1]).getByText('Element details')).toBeTruthy();
  const deleteImage = within(steps[0]).getByRole('button', { name: 'Delete screenshot' });
  expect(deleteImage.textContent).toBe('');
  fireEvent.click(deleteImage);
  expect(within(steps[0]).queryByRole('img')).toBeNull();
  expect(within(steps[1]).getByRole('img')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Delete step 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      steps: [expect.objectContaining({ id: 'click' })],
      images: [expect.objectContaining({ stepId: 'click' })],
    }),
  );
});
