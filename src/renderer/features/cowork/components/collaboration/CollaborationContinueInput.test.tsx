// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import { getContinueDraft, updateContinueDraft } from './collaborationContinueDraft';
import CollaborationContinueInput from './CollaborationContinueInput';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const speech = vi.hoisted(() => ({ callbacks: [] as Array<(text: string) => void> }));
vi.mock('../composer/LocalSpeechInputButton', () => ({
  LocalSpeechInputButton: ({
    disabled,
    onTranscript,
  }: {
    disabled: boolean;
    onTranscript: (text: string) => void;
  }) => {
    speech.callbacks.push(onTranscript);
    return (
      <button disabled={disabled} onClick={() => onTranscript('spoken')} aria-label="speech-input">
        Mic
      </button>
    );
  },
}));
afterEach(() => {
  cleanup();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});

it('submits an independent request and reports only source acceptance without claiming member execution', async () => {
  const key = crypto.randomUUID();
  updateContinueDraft(key, {
    text: 'Inspect the revised result',
    attachments: ['/project/evidence.png'],
  });
  const request = vi.fn().mockResolvedValue('source_accepted');
  render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  await screen.findByText('teamContinue_source_accepted');
  expect(request).toHaveBeenCalledWith({
    requestId: expect.any(String),
    message: 'Inspect the revised result',
    attachmentPaths: ['/project/evidence.png'],
  });
  expect(screen.queryByText('teamContinue_target_accepted')).toBeNull();
  expect(getContinueDraft(key)).toMatchObject({ text: '', attachments: [], pending: undefined });
});

it('restores voice insertion focus through the detached continuation window', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow!;
  const container = ownerDocument.createElement('div');
  ownerDocument.body.append(container);
  let focusFrame!: FrameRequestCallback;
  const raf = vi.fn((callback: FrameRequestCallback) => {
    focusFrame = callback;
    return 1;
  });
  Object.defineProperty(ownerWindow, 'requestAnimationFrame', { configurable: true, value: raf });
  const key = crypto.randomUUID();
  updateContinueDraft(key, { text: 'Review result' });
  const request = vi.fn();
  render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  const host = within(ownerDocument.body);
  const input = host.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(6, 6);
  fireEvent.click(host.getByRole('button', { name: 'speech-input' }));
  expect(raf).toHaveBeenCalledOnce();
  act(() => focusFrame(0));
  expect(ownerDocument.activeElement).toBe(input);
  expect(input.value).toBe('Review spoken result');
  expect(input.selectionStart).toBe(13);
  expect(request).not.toHaveBeenCalled();
});

it('preserves a failed request and freezes its identity after an uncertain response across remount', async () => {
  const key = crypto.randomUUID();
  updateContinueDraft(key, { text: 'Do not repeat uncertain work' });
  const request = vi.fn().mockRejectedValue(new Error('connection lost'));
  const view = render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  await screen.findByText('teamContinue_unknown');
  const original = getContinueDraft(key).pending;
  view.unmount();
  render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  expect(request).toHaveBeenCalledOnce();
  expect(getContinueDraft(key).pending).toBe(original);
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
    'Do not repeat uncertain work',
  );
});

it('keeps another member draft intact when the previous source response arrives late', async () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  updateContinueDraft(first, { text: 'First request' });
  updateContinueDraft(second, { text: 'Second member draft' });
  let resolve!: (state: 'target_accepted') => void;
  const request = vi.fn().mockImplementation(
    () =>
      new Promise<'target_accepted'>(finish => {
        resolve = finish;
      }),
  );
  const view = render(
    <CollaborationContinueInput draftKey={first} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  view.rerender(
    <CollaborationContinueInput draftKey={second} disabled={false} onRequestContinue={request} />,
  );
  await act(async () => resolve('target_accepted'));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second member draft');
  expect(screen.queryByText('teamContinue_target_accepted')).toBeNull();
  expect(getContinueDraft(first).status).toBe('target_accepted');
});

it('retains a newer same-member draft after source acceptance and does not send voice automatically', async () => {
  const key = crypto.randomUUID();
  updateContinueDraft(key, { text: 'Initial' });
  let resolve!: (state: 'source_accepted') => void;
  const request = vi.fn().mockImplementation(
    () =>
      new Promise<'source_accepted'>(finish => {
        resolve = finish;
      }),
  );
  render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'speech-input' }));
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  act(() => updateContinueDraft(key, { text: 'Newer draft', attachments: ['/new'] }));
  await act(async () => resolve('source_accepted'));
  await waitFor(() =>
    expect(getContinueDraft(key)).toMatchObject({
      text: 'Newer draft',
      attachments: ['/new'],
      pending: undefined,
    }),
  );
});

it('preserves rejected input so the user can resolve the source conflict', async () => {
  const key = crypto.randomUUID();
  updateContinueDraft(key, { text: 'Wait for idle' });
  const request = vi.fn().mockResolvedValue('rejected');
  render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  await screen.findByText('teamContinue_rejected');
  expect(getContinueDraft(key)).toMatchObject({ text: 'Wait for idle', pending: undefined });
});

it('ignores an earlier attachment picker and voice response after the request is accepted', async () => {
  const key = crypto.randomUUID();
  updateContinueDraft(key, { text: 'Earlier request' });
  let finishFiles!: (result: { success: true; paths: string[] }) => void;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      dialog: {
        selectFiles: vi.fn(
          () =>
            new Promise(resolve => {
              finishFiles = resolve;
            }),
        ),
      },
    },
  });
  const request = vi.fn().mockResolvedValue('source_accepted');
  render(
    <CollaborationContinueInput draftKey={key} disabled={false} onRequestContinue={request} />,
  );
  const oldSpeech = speech.callbacks[speech.callbacks.length - 1];
  fireEvent.click(screen.getByRole('button', { name: 'coworkAddFile' }));
  fireEvent.click(screen.getByRole('button', { name: 'teamRequestContinue' }));
  await screen.findByText('teamContinue_source_accepted');
  act(() => updateContinueDraft(key, { text: 'Later draft' }));
  await act(async () => {
    finishFiles({ success: true, paths: ['/earlier-file'] });
    oldSpeech('earlier speech');
  });
  expect(getContinueDraft(key)).toMatchObject({ text: 'Later draft', attachments: [] });
});
