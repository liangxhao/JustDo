import { describe, expect, it } from 'vitest';

import {
  normalizeInput,
  publicReceipt,
  trustedExtensionPage,
  validDocumentSender,
} from '../conversation-overlay/modules/web-launch-security.js';

const api = {
  runtime: {
    id: 'extension-id',
    getURL: (path: string) => `chrome-extension://extension-id/${path}`,
  },
};
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
        { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html?tabId=7' },
        api,
      ),
    ).toBe(true);
    expect(
      trustedExtensionPage(
        { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html?tabId=7&x=1' },
        api,
      ),
    ).toBe(false);
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
      result: 'final',
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
      input: { text: 'edited prompt', context: { text: 'private' } },
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
      input: { text: 'edited prompt' },
      output: { status: 'available', text: 'answer', format: 'text' },
      delivery: { status: 'connected' },
      error: { code: 'INVALID_REQUEST', messageKey: 'webLaunchErrorINVALID_REQUEST' },
    });
    expect(publicReceipt(source, false)?.output).toEqual({ status: 'available' });
    expect(publicReceipt(source, false)?.input).toBeUndefined();
    expect(publicReceipt({ ...source, input: { text: 'x'.repeat(16_001) } }, true)?.input).toBeUndefined();
    expect(publicReceipt({ ...source, output: { status: 'withheld' } }, true)?.input).toBeUndefined();
    expect(publicReceipt({ ...source, request: { status: 'submitting' } }, true)?.input).toBeUndefined();
    expect(publicReceipt({ ...source, delivery: { status: 'revoked' } }, true)?.input).toBeUndefined();
    expect(
      publicReceipt({ ...source, execution: { status: 'running', executionSettled: false } }, true)
        ?.output,
    ).toEqual({ status: 'available' });
  });

  it('limits artifact-only output to authorized completed results and safe metadata', () => {
    const artifact = { name: 'table.csv', kind: 'document', mimeType: 'text/csv' };
    const source = {
      requestId: 'request-1',
      launchId: 'launch-1',
      receiptRevision: 3,
      request: { status: 'submitted' },
      execution: { status: 'completed', executionSettled: true },
      output: {
        status: 'available',
        artifacts: [
          { ...artifact, path: 'C:/private/table.csv', source: 'private', bytes: 'private' },
          { ...artifact, name: 'C:/private/file.txt' },
          { ...artifact, name: 'file%3A%2F%2Fsecret.txt' },
          { ...artifact, name: 'z'.repeat(256) },
        ],
      },
      delivery: { status: 'connected' },
    };
    expect(publicReceipt(source, true)?.output).toEqual({
      status: 'available', artifacts: [artifact],
    });
    expect(publicReceipt(source, false)?.output).toEqual({ status: 'available' });
    expect(publicReceipt({ ...source, delivery: { status: 'revoked' } }, true)?.output)
      .toEqual({ status: 'available' });
    expect(publicReceipt({ ...source, execution: { status: 'failed', executionSettled: true } }, true)
      ?.output).toEqual({ status: 'available' });
    const many = { ...source, output: { status: 'available', artifacts: Array(40).fill(artifact) } };
    expect(publicReceipt(many, true)?.output.artifacts).toHaveLength(32);
  });
});
