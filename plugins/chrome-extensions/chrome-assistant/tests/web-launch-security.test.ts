import { describe, expect, it } from 'vitest';
import {
  normalizeInput,
  publicReceipt,
  trustedExtensionPage,
  validDocumentSender,
} from '../conversation-overlay/modules/web-launch-security.js';

const api = { runtime: { id: 'extension-id' } };
const sender = {
  id: 'extension-id',
  frameId: 0,
  documentId: 'document-1',
  documentLifecycle: 'active',
  origin: 'https://business.test:8443',
  url: 'https://business.test:8443/record',
  tab: { id: 1, windowId: 2 },
};

describe('web launch trust boundaries', () => {
  it('separates content scripts from trusted extension pages and requires exact document origin', () => {
    expect(trustedExtensionPage(sender, api)).toBe(false);
    expect(
      trustedExtensionPage(
        { id: 'extension-id', url: 'chrome-extension://extension-id/options.html', frameId: 0 },
        api,
      ),
    ).toBe(true);
    expect(
      trustedExtensionPage(
        { id: 'extension-id', url: 'chrome-extension://extension-id/unknown.html' },
        api,
      ),
    ).toBe(false);
    expect(validDocumentSender(sender, api)).toBe(true);
    expect(validDocumentSender({ ...sender, frameId: 1 }, api)).toBe(false);
    expect(validDocumentSender({ ...sender, origin: 'https://business.test' }, api)).toBe(false);
    expect(validDocumentSender({ ...sender, documentLifecycle: 'cached' }, api)).toBe(false);
  });

  it('rejects privileged/oversized input and copies defaults', () => {
    expect(normalizeInput({ prompt: 'hello' })).toEqual({
      prompt: 'hello',
      mode: 'draft',
      result: 'none',
    });
    expect(normalizeInput({ prompt: 'hello', permissionMode: 'full' })).toBeNull();
    expect(normalizeInput({ prompt: 'x'.repeat(16_001) })).toBeNull();
    expect(
      normalizeInput({ prompt: 'hello', context: { text: 'ok', token: 'secret' } }),
    ).toBeNull();
  });

  it('reconstructs a bounded public receipt without native IDs, credentials, arbitrary errors or unsettled text', () => {
    const source = {
      requestId: 'request-1',
      launchId: 'launch-1',
      receiptRevision: 3,
      request: { status: 'submitted', threadId: 'private' },
      execution: { status: 'completed', executionSettled: true, nativeRunId: 'private' },
      output: { status: 'available', text: 'answer', format: 'html', token: 'secret' },
      delivery: { status: 'connected' },
      error: { code: 'INVALID_REQUEST', messageKey: 'ws://127.0.0.1/token', stack: 'private' },
      localAppServerUrl: 'secret',
    };
    expect(publicReceipt(source, true)).toEqual({
      requestId: 'request-1',
      launchId: 'launch-1',
      receiptRevision: 3,
      request: { status: 'submitted' },
      execution: { status: 'completed', executionSettled: true },
      output: { status: 'available', text: 'answer', format: 'text' },
      delivery: { status: 'connected' },
      error: { code: 'INVALID_REQUEST', messageKey: 'webLaunchErrorINVALID_REQUEST' },
    });
    expect(publicReceipt(source, false)?.output).toEqual({ status: 'available' });
    expect(
      publicReceipt({ ...source, execution: { status: 'running', executionSettled: false } }, true)
        ?.output,
    ).toEqual({ status: 'available' });
  });
});
