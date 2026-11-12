/** @vitest-environment jsdom */

import './justdo-chat';

import {
  AutomaticErrorRetryDisposition as Disposition,
  AutomaticErrorRetryPhase as Phase,
  type AutomaticErrorRetryPresentation,
} from '@shared/cowork/automaticErrorRetry';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AssistantTurn } from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';

const error = 'synthetic repeated failure';
const receipt = (disposition: AutomaticErrorRetryPresentation['runs'][number]['disposition'],
  phase: AutomaticErrorRetryPresentation['phase'], revision = 1): AutomaticErrorRetryPresentation => ({
  sessionId: 'product', chainId: 'chain', revision, phase, attempt: 1, maxContinuations: 2,
  runs: [{ chainId: 'chain', attempt: 0, maxContinuations: 2, runId: 'native-run',
    clientTurnId: 'turn', sessionKey: 'agent:main:justdo:product', nativeSessionId: 'native-session',
    lifecycleRevision: 'one', disposition }],
});

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('holds errors across pending and unknown retries and reveals only the final failure', async () => {
  let publish!: (value: AutomaticErrorRetryPresentation) => void;
  let resolve!: (value: unknown) => void;
  const remove = vi.fn();
  const original = window.electron;
  Object.defineProperty(window, 'electron', { configurable: true, value: {
    ...original,
    cowork: {
      ...original?.cowork,
      getAutomaticErrorRetry: vi.fn(() => new Promise(value => { resolve = value; })),
      onAutomaticErrorRetryChanged: (callback: typeof publish) => { publish = callback; return remove; },
    },
  } });
  try {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.productSessionId = 'product';
    chat.messages = [{ role: 'assistant', content: error, errorMessage: error, stopReason: 'error',
      runId: 'native-run', __openclaw: { id: 'error-entry', runId: 'native-run' } }];
    chat.activeTurn = {
      runId: 'native-run', sessionId: 'native-session', sessionKey: 'agent:main:justdo:product',
      lifecycleGeneration: null, id: 'turn', status: 'error', lastAgentSeq: 2,
      startedAt: 1, endedAt: 2, toolById: new Map(), items: [{ id: 'terminal', runId: 'native-run',
        firstSeq: 2, lastSeq: 2, startedAt: 2, updatedAt: 2, type: 'terminal', status: 'error', message: error }],
    } satisfies AssistantTurn;
    document.body.append(chat);
    await chat.updateComplete;
    expect(chat.shadowRoot!.textContent).not.toContain(error);

    const pending = receipt(Disposition.Pending, Phase.Preparing);
    resolve({ success: true, presentations: [pending] });
    await vi.waitFor(async () => {
      await chat.updateComplete;
      expect(chat.shadowRoot!.querySelector('[data-automatic-error-retry]')).not.toBeNull();
    });
    expect(chat.shadowRoot!.textContent).not.toContain(error);
    expect(chat.shadowRoot!.querySelector('[data-automatic-error-retry]')).not.toBeNull();

    const finalError = 'last retry failure';
    const successor = { ...pending.runs[0], runId: 'successor', clientTurnId: 'successor', attempt: 1 };
    chat.messages = [...chat.messages, { role: 'assistant', content: finalError, errorMessage: finalError,
      stopReason: 'error', runId: 'successor', __openclaw: { id: 'successor-entry', runId: 'successor' } }];
    publish({ ...pending, revision: 2, phase: Phase.Unknown, runs: [...pending.runs, successor] });
    await chat.updateComplete;
    expect(chat.shadowRoot!.textContent).not.toContain(error);
    expect(chat.shadowRoot!.textContent).not.toContain(finalError);
    expect(chat.shadowRoot!.querySelector('[data-automatic-error-retry]')).not.toBeNull();

    publish({ ...pending, revision: 3, phase: Phase.Failed, runs: [
      { ...pending.runs[0], disposition: Disposition.Superseded },
      { ...successor, disposition: Disposition.Final },
    ] });
    await chat.updateComplete;
    expect(chat.shadowRoot!.textContent).not.toContain(error);
    expect(chat.shadowRoot!.textContent).toContain(finalError);
    expect(chat.shadowRoot!.querySelector('[data-automatic-error-retry]')).toBeNull();
    chat.remove();
    expect(remove).toHaveBeenCalledOnce();
  } finally {
    Object.defineProperty(window, 'electron', { configurable: true, value: original });
  }
});

test('renders ordinary history immediately while retry metadata is still loading', async () => {
  const original = window.electron;
  Object.defineProperty(window, 'electron', { configurable: true, value: {
    ...original,
    cowork: {
      ...original?.cowork,
      getAutomaticErrorRetry: () => new Promise(() => {}),
      onAutomaticErrorRetryChanged: () => () => {},
    },
  } });
  try {
    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    chat.productSessionId = 'product';
    chat.messages = [{ role: 'assistant', content: 'Ordinary answer', __openclaw: { id: 'reply' } }];
    document.body.append(chat);
    await chat.updateComplete;
    expect(chat.shadowRoot!.textContent).toContain('Ordinary answer');
    expect(chat.shadowRoot!.querySelector('[data-automatic-error-retry]')).toBeNull();
    chat.remove();
  } finally {
    Object.defineProperty(window, 'electron', { configurable: true, value: original });
  }
});
