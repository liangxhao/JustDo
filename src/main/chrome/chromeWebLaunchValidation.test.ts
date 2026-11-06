import { describe, expect, it } from 'vitest';

import { canonicalWebLaunchInput } from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import { parseWebLaunchPrepare, parseWebLaunchSource, webLaunchDigest } from './chromeWebLaunchValidation';

const source = { chromeInstanceId: 'browser', windowInstanceId: 'window', windowId: 1, tabId: 1, frameId: 0, documentId: 'doc', channelGeneration: 1, origin: 'https://example.test:8443' };

describe('webpage launch boundary validation', () => {
  it('requires an exact HTTP(S) origin and browser top-level frame identity', () => {
    expect(() => parseWebLaunchSource({ ...source, origin: 'https://example.test:8443/' })).toThrow('INVALID_ORIGIN');
    expect(() => parseWebLaunchSource({ ...source, frameId: 1 })).toThrow('INVALID_SOURCE');
    expect(() => parseWebLaunchSource({ ...source, url: 'https://example.test:9443/path' })).toThrow('INVALID_SOURCE');
    expect(() => parseWebLaunchSource({ ...source, origin: 'file:///private' })).toThrow('INVALID_ORIGIN');
  });

  it('rejects forbidden fields and a digest that does not bind the immutable input', () => {
    const input = { prompt: 'fixture prompt', mode: 'draft', result: 'none' } as const;
    const prepare = { source, requestId: 'request', bindingRevision: 1, clickSequence: 1, input, payloadDigest: webLaunchDigest(canonicalWebLaunchInput(input)) };
    expect(parseWebLaunchPrepare(prepare).input).toEqual(input);
    expect(() => parseWebLaunchPrepare({ ...prepare, input: { ...input, permissionMode: 'full' } })).toThrow('INVALID_REQUEST');
    expect(() => parseWebLaunchPrepare({ ...prepare, input: { ...input, prompt: 'another request' } })).toThrow('REQUEST_CONFLICT');
  });
});
