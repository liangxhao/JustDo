// @vitest-environment jsdom
import { type BrowserRecordingDraft, serializeRecording } from '@shared/browser/browserRecording';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { BrowserRecordingReview } from './BrowserRecordingReview';
import { recordingSubmissionIssue } from './browserRecordingSubmission';

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

const networkDraft: BrowserRecordingDraft = {
  id: 'network-demonstration',
  sessionId: 'session',
  profile: 'embedded',
  title: '',
  note: '',
  startedAt: 0,
  steps: [
    {
      id: 'navigation',
      pageId: 'orders',
      action: 'navigate',
      at: 0,
      title: 'Orders',
      url: 'https://app.example/',
    },
    {
      id: 'search',
      pageId: 'orders',
      action: 'input',
      at: 1,
      title: 'Orders',
      url: 'https://app.example/',
      value: '123',
    },
  ],
  images: [],
  capturedNetwork: {
    entries: [
      {
        id: 'page-load',
        pageId: 'orders',
        stepId: 'navigation',
        group: 'load',
        loadSequence: 1,
        type: 'document',
        method: 'GET',
        outcome: 'complete',
        status: 200,
        origin: 'https://app.example',
        path: '/',
      },
      {
        id: 'request',
        pageId: 'orders',
        stepId: 'search',
        group: 'action',
        type: 'fetch',
        method: 'POST',
        outcome: 'complete',
        status: 201,
        origin: 'https://api.example',
        path: '/orders/123',
        search: '?page=2',
      },
      {
        id: 'polling',
        pageId: 'orders',
        group: 'unassigned',
        type: 'xhr',
        method: 'GET',
        outcome: 'complete',
        status: 200,
        origin: 'https://api.example',
        path: '/status',
      },
    ],
    coverage: [],
    omittedCount: 0,
  },
};

it('adds all captured requests to the draft without attaching a network summary', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  render(
    <BrowserRecordingReview
      draft={networkDraft}
      onSave={save}
      onClose={() => {}}
      saveLabel="recordingAdd"
    />,
  );

  expect(screen.getByText('3 request entries · 0 to send')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add to conversation' }));

  const saved = save.mock.calls[0][0] as BrowserRecordingDraft;
  expect(saved.capturedNetwork?.entries).toEqual(networkDraft.capturedNetwork?.entries);
  expect(JSON.parse(serializeRecording(saved))).not.toHaveProperty('network');
});

it('shows compact replay evidence and leaves routine capture diagnostics out of review', () => {
  i18nService.setLanguage('en', { persist: false });
  const capture = networkDraft.capturedNetwork!;
  const [load, action] = capture.entries;
  const draft: BrowserRecordingDraft = {
    ...networkDraft,
    capturedNetwork: {
      ...capture,
      entries: [
        { ...load, status: 302, outcome: 'redirected' },
        action,
        {
          ...action,
          id: 'failed',
          path: '/request-failed',
          status: undefined,
          outcome: 'failed',
          failure: 'dns',
        },
      ],
      coverage: ['clock', 'late-start', 'unattributed'],
    },
  };
  render(<BrowserRecordingReview draft={draft} onSave={() => {}} onClose={() => {}} />);

  fireEvent.click(screen.getByText('Network details'));
  fireEvent.click(screen.getByText('Page loads'));
  fireEvent.click(screen.getByText('Observed after an action'));
  const loadGroup = within(screen.getByText('Page loads').closest('details')!);
  expect(loadGroup.getAllByText('https://app.example/')).toHaveLength(1);
  expect(loadGroup.getByText('GET')).toBeTruthy();
  expect(loadGroup.getByText('HTTP 302')).toBeTruthy();
  expect(loadGroup.getByText(/Step 1 · app\.example/)).toBeTruthy();
  expect(loadGroup.queryByText(/Total time|Request type|Redirect chain/)).toBeNull();
  const actionGroup = within(screen.getByText('Observed after an action').closest('details')!);
  expect(actionGroup.getAllByText('https://api.example/orders/123?page=2')).toHaveLength(1);
  expect(actionGroup.queryByText('HTTP 201')).toBeNull();
  expect(actionGroup.getByText('DNS resolution failed')).toBeTruthy();
  expect(
    screen.queryByText(
      /before network capture was ready|timestamps could not be aligned|originating page could not be verified/,
    ),
  ).toBeNull();
  expect(screen.getAllByText('Network capture is partial')).toHaveLength(1);
});

it('saves a failed first navigation without steps and requires network entries to send it', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const capture = networkDraft.capturedNetwork!;
  const entry = {
    ...capture.entries[0],
    stepId: undefined,
    outcome: 'failed',
    failure: 'dns',
    status: undefined,
  } as const;
  const draft: BrowserRecordingDraft = {
    ...networkDraft,
    steps: [],
    capturedNetwork: { ...capture, entries: [entry] },
  };
  render(
    <BrowserRecordingReview
      draft={draft}
      onSave={save}
      onClose={() => {}}
      saveLabel="recordingAdd"
    />,
  );

  const add = screen.getByRole('button', { name: 'Add to conversation' });
  fireEvent.click(add);
  const local = save.mock.calls[0][0] as BrowserRecordingDraft;
  expect(local.capturedNetwork?.entries).toEqual([entry]);
  expect(recordingSubmissionIssue(local, [], true)).toBe('recordingNetworkOnlySubmission');

  fireEvent.click(screen.getByText('Network details'));
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: 'Include a network summary with the demonstration',
    }),
  );
  fireEvent.click(add);
  const attached = save.mock.calls[1][0] as BrowserRecordingDraft;
  expect(recordingSubmissionIssue(attached, [], true)).toBeNull();
  expect(JSON.parse(serializeRecording(attached)).network.entries).toMatchObject([
    { outcome: 'failed', failure: 'dns', type: 'document' },
  ]);
});

it('uses selected address modes for sending and preserves the original local request', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  render(<BrowserRecordingReview draft={networkDraft} onSave={save} onClose={() => {}} />);

  fireEvent.click(screen.getByText('Network details'));
  const include = screen.getByRole('checkbox', {
    name: 'Include a network summary with the demonstration',
  });
  fireEvent.click(include);
  expect(screen.getByText('3 request entries · 2 to send')).toBeTruthy();
  fireEvent.click(screen.getByText('Observed after an action'));
  const address = screen.getByText('https://api.example/orders/123?page=2');
  const request = within(address.closest('li')!);
  fireEvent.change(request.getByLabelText('Address to send'), {
    target: { value: 'without-query' },
  });
  fireEvent.click(include);
  fireEvent.click(include);
  expect((request.getByLabelText('Address to send') as HTMLSelectElement).value).toBe(
    'without-query',
  );
  fireEvent.click(screen.getByText('Page loads'));
  const loadGroup = screen.getByText('Page loads').closest('details')!;
  fireEvent.click(within(loadGroup).getByRole('button', { name: 'Deselect this group' }));
  expect(screen.getByText('3 request entries · 1 to send')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const saved = save.mock.calls[0][0] as BrowserRecordingDraft;
  expect(saved.capturedNetwork?.entries[1].search).toBe('?page=2');
  const { entries } = JSON.parse(serializeRecording(saved)).network;
  expect(entries).toMatchObject([{ path: '/orders/123' }]);
  expect(entries[0]).not.toHaveProperty('search');
});

it('can omit a query from the message when the captured path was not retained', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const capture = networkDraft.capturedNetwork!;
  const draft: BrowserRecordingDraft = {
    ...networkDraft,
    capturedNetwork: {
      ...capture,
      include: true,
      entries: [{ ...capture.entries[1], path: '', urlLimited: true }],
    },
  };
  render(<BrowserRecordingReview draft={draft} onSave={save} onClose={() => {}} />);

  fireEvent.click(screen.getByText('Network details'));
  fireEvent.click(screen.getByText('Observed after an action'));
  const address = screen.getByText('https://api.example?page=2');
  const request = within(address.closest('li')!);
  fireEvent.change(request.getByLabelText('Address to send'), { target: { value: 'origin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const saved = save.mock.calls[0][0] as BrowserRecordingDraft;
  expect(saved.capturedNetwork?.entries[0].search).toBe('?page=2');
  const { entries } = JSON.parse(serializeRecording(saved)).network;
  expect(entries).toMatchObject([{ origin: 'https://api.example', path: '' }]);
  expect(entries[0]).not.toHaveProperty('search');
});

it('retains a request for review after editing its step and excludes it from the outgoing summary', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const draft = {
    ...networkDraft,
    capturedNetwork: { ...networkDraft.capturedNetwork!, include: true },
  };
  render(<BrowserRecordingReview draft={draft} onSave={save} onClose={() => {}} />);

  fireEvent.change(screen.getByLabelText('Input value 2'), { target: { value: '456' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const saved = save.mock.calls[0][0] as BrowserRecordingDraft;
  expect(saved.capturedNetwork?.entries.find(entry => entry.id === 'request')).toMatchObject({
    group: 'unassigned',
    stepId: undefined,
    path: '/orders/123',
    search: '?page=2',
  });
  expect(JSON.parse(serializeRecording(saved)).network.entries).toMatchObject([{ path: '/' }]);
});

it('keeps a loading request available to attach after its navigation step is deleted', () => {
  i18nService.setLanguage('en', { persist: false });
  const save = vi.fn();
  const draft = {
    ...networkDraft,
    capturedNetwork: { ...networkDraft.capturedNetwork!, include: true },
  };
  render(<BrowserRecordingReview draft={draft} onSave={save} onClose={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: 'Delete step 1' }));
  expect(screen.getByText('3 request entries · 1 to send')).toBeTruthy();
  fireEvent.click(screen.getByText('Network details'));
  fireEvent.click(screen.getByText('Page loads'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include GET https://app.example/' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  const saved = save.mock.calls[0][0] as BrowserRecordingDraft;
  const { entries } = JSON.parse(serializeRecording(saved)).network;
  expect(entries[0]).toMatchObject({ group: 'load', path: '/', loadSequence: 1 });
  expect(entries[0]).not.toHaveProperty('stepId');
});
