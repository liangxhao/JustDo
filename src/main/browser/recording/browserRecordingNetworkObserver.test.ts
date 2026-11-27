import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  RECORDING_NETWORK_LIMITS,
  type RecordingNetworkLeaseRef,
} from '../../../shared/browser/browserRecordingNetwork';
import {
  BrowserRecordingNetworkObserver,
  type RecordingNetworkTarget,
} from './browserRecordingNetworkObserver';

const owner = 10;
const epoch = 1_767_000_000_000;
const lease: RecordingNetworkLeaseRef = {
  recordingId: 'recording-1',
  sessionId: 'session-1',
  profile: 'embedded',
};

function target(
  id = 1,
  url = 'about:blank',
  resourceSessionId = lease.sessionId,
): RecordingNetworkTarget {
  return {
    page: { resourceSessionId, targetId: `page-${id}`, expectedWebContentsId: id },
    guest: {},
    isCurrent: () => true,
    prepare: async () => ({ frameTree: { frame: { id: 'root', loaderId: 'old-loader', url } } }),
  };
}

const clock = (ms: number): number => epoch + ms;
const cdptime = (ms: number): number => 100 + ms / 1_000;
const position = (ms: number): void => vi.setSystemTime(clock(ms));

function sendRequest(
  observer: BrowserRecordingNetworkObserver,
  page: RecordingNetworkTarget,
  requestId: string,
  ms: number,
  overrides: Record<string, unknown> = {},
): void {
  observer.observe(page.guest, 'Network.requestWillBeSent', {
    requestId,
    frameId: 'root',
    loaderId: 'old-loader',
    type: 'Fetch',
    wallTime: clock(ms) / 1_000,
    timestamp: cdptime(ms),
    request: { url: 'https://api.example.test/orders', method: 'GET' },
    ...overrides,
  });
}

function endRequest(
  observer: BrowserRecordingNetworkObserver,
  page: RecordingNetworkTarget,
  requestId: string,
  ms: number,
  status = 200,
): void {
  observer.observe(page.guest, 'Network.responseReceived', {
    requestId,
    timestamp: cdptime(ms),
    type: 'Fetch',
    response: { status, mimeType: 'application/json', protocol: 'h2' },
  });
  observer.observe(page.guest, 'Network.loadingFinished', {
    requestId,
    timestamp: cdptime(ms + 1),
    encodedDataLength: 123,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  position(0);
});

afterEach(() => vi.useRealTimers());

test('gives a cached document restoration a new visible interval even when Chromium reuses its loader', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://front.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);

  position(2);
  sendRequest(observer, page, 'before-away', 1);
  endRequest(observer, page, 'before-away', 1);
  position(10);
  sendRequest(observer, page, 'away', 9, {
    type: 'Document',
    loaderId: 'away-loader',
    request: { url: 'https://other.example.test/', method: 'GET' },
  });
  observer.observe(page.guest, 'Page.frameNavigated', {
    frame: { id: 'root', loaderId: 'away-loader', url: 'https://other.example.test/' },
  });
  endRequest(observer, page, 'away', 10);

  position(18);
  observer.observe(page.guest, 'Page.frameNavigated', {
    type: 'BackForwardCacheRestore',
    frame: { id: 'root', loaderId: 'old-loader', url: 'https://front.example.test/' },
  });
  position(22);
  sendRequest(observer, page, 'after-back', 20);
  endRequest(observer, page, 'after-back', 21);

  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(22),
  });
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [
        { documentId: 1, startedAtMs: clock(1), type: 'fetch' },
        { documentId: 3, startedAtMs: clock(20), type: 'fetch' },
      ],
      segments: [
        {
          documents: [
            { id: 1, startedAtMs: clock(0), committedAtMs: clock(0), endedAtMs: clock(10) },
            {
              id: 2,
              startedAtMs: clock(9),
              committedAtMs: clock(10),
              endedAtMs: clock(18),
              loadSequence: 1,
            },
            { id: 3, startedAtMs: clock(18), committedAtMs: clock(18), endedAtMs: clock(22) },
          ],
        },
      ],
    },
  });
});

test('excludes subresources after a recorded navigation enters a private preview under the same loader', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target();
  const localPreview = `http://127.0.0.1:42100/${'x'.repeat(32)}/private.html`;
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);

  position(10);
  sendRequest(observer, page, 'signed-in', 1, {
    type: 'Document',
    loaderId: 'navigating',
    request: { url: 'https://front.example.test/start', method: 'GET' },
  });
  sendRequest(observer, page, 'signed-in', 2, {
    type: 'Document',
    loaderId: 'navigating',
    redirectResponse: { status: 302 },
    request: { url: localPreview, method: 'GET' },
  });
  sendRequest(observer, page, 'early-preview-api', 3, {
    loaderId: 'navigating',
    documentURL: localPreview,
  });
  observer.observe(page.guest, 'Page.frameNavigated', {
    frame: { id: 'root', loaderId: 'navigating', url: localPreview },
  });
  sendRequest(observer, page, 'committed-preview-api', 10, { loaderId: 'navigating' });

  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(10),
  });
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: { entries: [] },
  });
  expect(JSON.stringify(result)).not.toContain(localPreview);
});

test('groups bootstrap APIs across navigation while omitting regular document and redirect rows', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target();
  await expect(
    observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page),
  ).resolves.toMatchObject({ status: 'ready', segmentId: 1 });

  position(5);
  sendRequest(observer, page, 'navigation', 1, {
    type: 'Document',
    loaderId: 'next-loader',
    request: { url: 'https://front.example.test/start', method: 'GET' },
  });
  sendRequest(observer, page, 'navigation', 2, {
    type: 'Document',
    loaderId: 'next-loader',
    redirectResponse: { status: 302 },
    request: { url: 'https://portal.example.test/signed-in', method: 'GET' },
  });
  sendRequest(observer, page, 'bootstrap', 3, {
    type: 'Other',
    loaderId: 'next-loader',
    request: { url: 'https://api.example.test/bootstrap?page=2', method: 'GET' },
  });
  endRequest(observer, page, 'bootstrap', 4);
  observer.observe(page.guest, 'Page.frameNavigated', {
    frame: { id: 'root', loaderId: 'next-loader', url: 'https://portal.example.test/signed-in' },
  });
  endRequest(observer, page, 'navigation', 5);
  observer.observe(page.guest, 'Page.frameNavigated', {
    frame: {
      id: 'subframe',
      parentId: 'root',
      loaderId: 'child-loader',
      url: 'https://portal.example.test/frame',
    },
  });
  position(20);
  sendRequest(observer, page, 'write', 10, {
    loaderId: 'child-loader',
    frameId: 'subframe',
    request: {
      url: 'https://api.example.test/orders/123?page=2&access_token=hidden-value',
      method: 'POST',
      headers: { Authorization: 'hidden-header' },
      postData: 'hidden-body',
    },
  });
  endRequest(observer, page, 'write', 19, 422);
  sendRequest(observer, page, 'unowned', 12, { frameId: 'unknown', loaderId: 'random' });
  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(20),
  });

  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [
        {
          type: 'fetch',
          path: '/bootstrap',
          search: '?page=2',
          loadSequence: 1,
          withinLoad: true,
          outcome: 'complete',
          status: 200,
        },
        {
          frame: 'child',
          withinLoad: true,
          type: 'fetch',
          method: 'POST',
          origin: 'https://api.example.test',
          path: '/orders/123',
          outcome: 'complete',
          status: 422,
          urlRedacted: true,
        },
      ],
      segments: [
        {
          id: 1,
          webContentsId: 1,
          documents: expect.arrayContaining([expect.objectContaining({ loadSequence: 1 })]),
        },
      ],
      coverage: ['unattributed'],
    },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /hidden-value|hidden-header|hidden-body|child-loader|next-loader|mime|protocol|transferredBytes|durationMs|responseMs/,
  );
});

test('keeps failed document loads, form navigations and actual OPTIONS while ignoring CORS preflights', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://front.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);

  position(10);
  sendRequest(observer, page, 'form', 1, {
    type: 'Document',
    loaderId: 'form-loader',
    request: { url: 'https://front.example.test/submit', method: 'POST' },
  });
  sendRequest(observer, page, 'form', 2, {
    type: 'Document',
    loaderId: 'form-loader',
    redirectResponse: { status: 303 },
    request: { url: 'https://front.example.test/success', method: 'GET' },
  });
  endRequest(observer, page, 'form', 3);
  sendRequest(observer, page, 'bad-status', 4, {
    type: 'Document',
    loaderId: 'error-loader',
    request: { url: 'https://front.example.test/missing', method: 'GET' },
  });
  endRequest(observer, page, 'bad-status', 5, 404);
  sendRequest(observer, page, 'unavailable', 6, {
    type: 'Document',
    loaderId: 'unavailable-loader',
    request: { url: 'https://bad.example.test/', method: 'GET' },
  });
  observer.observe(page.guest, 'Network.loadingFailed', {
    requestId: 'unavailable',
    timestamp: cdptime(7),
    type: 'Document',
    errorText: 'net::ERR_CERT_AUTHORITY_INVALID',
  });
  sendRequest(observer, page, 'preflight', 8, {
    type: 'Preflight',
    request: { url: 'https://api.example.test/preflight', method: 'OPTIONS' },
  });
  sendRequest(observer, page, 'application-options', 9, {
    request: { url: 'https://api.example.test/business', method: 'OPTIONS' },
  });
  endRequest(observer, page, 'application-options', 10);

  expect(
    await observer.apply(owner, {
      lease,
      sequence: 2,
      action: 'finish',
      requestedAtMs: clock(10),
    }),
  ).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [
        { type: 'document', method: 'POST', path: '/submit', outcome: 'redirected', status: 303 },
        { type: 'document', method: 'GET', path: '/missing', outcome: 'complete', status: 404 },
        {
          type: 'document',
          method: 'GET',
          origin: 'https://bad.example.test',
          outcome: 'failed',
          failure: 'tls',
        },
        { type: 'fetch', method: 'OPTIONS', path: '/business', outcome: 'complete', status: 200 },
      ],
    },
  });
});

test('suspends old targets and only completes admitted requests during the bounded stop grace', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const a = target(1, 'https://site.example.test/');
  const b = target(2, 'https://site.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: a.page }, a);
  position(5);
  sendRequest(observer, a, 'pending', 1);
  await observer.apply(
    owner,
    { lease, sequence: 2, action: 'setTarget', page: b.page, requestedAtMs: clock(5) },
    b,
  );
  position(10);
  sendRequest(observer, a, 'background', 9);
  endRequest(observer, a, 'pending', 9);
  await observer.apply(
    owner,
    { lease, sequence: 3, action: 'setTarget', page: a.page, requestedAtMs: clock(10) },
    a,
  );
  position(16);
  sendRequest(observer, a, 'admitted', 11);
  sendRequest(observer, a, 'slow', 12);
  sendRequest(observer, a, 'after-click-before-ipc', 15);
  const stop = { lease, sequence: 4, action: 'finish', requestedAtMs: clock(14) } as const;
  const pending = observer.apply(owner, stop);
  sendRequest(observer, a, 'after-stop', 16);
  endRequest(observer, a, 'admitted', 16);
  expect(observer.apply(owner, stop)).toBe(pending);
  await vi.advanceTimersByTimeAsync(RECORDING_NETWORK_LIMITS.finishMs);

  const result = await pending;
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [
        { segmentId: 1, startedAtMs: clock(1), outcome: 'unfinished' },
        { segmentId: 3, startedAtMs: clock(11), outcome: 'complete' },
        { segmentId: 3, startedAtMs: clock(12), outcome: 'unfinished' },
      ],
      segments: [{ id: 1 }, { id: 2 }, { id: 3, endedAtMs: clock(14) }],
    },
  });
});

test('retains requests that become relevant only after stop during the finish grace', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://front.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);

  position(5);
  sendRequest(observer, page, 'unclassified', 1, { type: undefined });
  sendRequest(observer, page, 'image', 2, { type: 'Image' });
  sendRequest(observer, page, 'navigation', 3, {
    type: 'Document',
    loaderId: 'next-loader',
    request: { url: 'https://front.example.test/missing', method: 'GET' },
  });

  const stopped = observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(5),
  });
  position(10);
  endRequest(observer, page, 'unclassified', 9);
  observer.observe(page.guest, 'Network.loadingFailed', {
    requestId: 'navigation',
    timestamp: cdptime(10),
    type: 'Document',
    errorText: 'net::ERR_NAME_NOT_RESOLVED',
  });

  expect(await stopped).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [
        { type: 'fetch', path: '/orders', outcome: 'complete', status: 200 },
        { type: 'document', path: '/missing', outcome: 'failed', failure: 'dns' },
      ],
    },
  });
});

test('a delayed debugger readiness cannot reopen a paused recording', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  const originalPrepare = page.prepare;
  let ready: ((value: unknown) => void) | undefined;
  page.prepare = () =>
    new Promise(resolve => {
      ready = resolve;
    });
  const start = observer.apply(
    owner,
    { lease, sequence: 1, action: 'start', page: page.page },
    page,
  );
  await Promise.resolve();
  await expect(
    observer.apply(owner, { lease, sequence: 2, action: 'pause', requestedAtMs: clock(0) }),
  ).resolves.toMatchObject({ status: 'paused' });

  ready?.(await originalPrepare());
  await expect(start).resolves.toMatchObject({ status: 'stale' });
  position(10);
  sendRequest(observer, page, 'while-paused', 9);
  const result = await observer.apply(owner, {
    lease,
    sequence: 3,
    action: 'finish',
    requestedAtMs: clock(10),
  });
  expect(result).toMatchObject({ status: 'finished', snapshot: { entries: [] } });
});

test('ignores readiness noise and preserves the requested cutoff after delayed IPC', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  const originalPrepare = page.prepare;
  let ready: ((value: unknown) => void) | undefined;
  page.prepare = () =>
    new Promise(resolve => {
      ready = resolve;
    });
  const start = observer.apply(
    owner,
    { lease, sequence: 1, action: 'start', page: page.page },
    page,
  );
  await Promise.resolve();
  sendRequest(observer, page, 'favicon', 1, { type: 'Image' });
  sendRequest(observer, page, 'page-document', 1, { type: 'Document' });
  sendRequest(observer, page, 'before-lease', -1);
  for (const [index, url] of [
    'data:text/plain,inline',
    'blob:https://site.example.test/example',
    `http://127.0.0.1:42100/${'x'.repeat(32)}/private.html`,
  ].entries()) {
    sendRequest(observer, page, `skipped-${index}`, 1, { request: { url, method: 'GET' } });
  }
  ready?.(await originalPrepare());
  await start;

  position(2_000);
  sendRequest(observer, page, 'before-pause', 3);
  endRequest(observer, page, 'before-pause', 4);
  sendRequest(observer, page, 'after-pause', 30);
  endRequest(observer, page, 'after-pause', 32);
  await observer.apply(owner, { lease, sequence: 2, action: 'pause', requestedAtMs: clock(10) });

  expect(
    await observer.apply(owner, {
      lease,
      sequence: 3,
      action: 'finish',
      requestedAtMs: clock(2_000),
    }),
  ).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [{ type: 'fetch', startedAtMs: clock(3), status: 200 }],
      coverage: [],
      segments: [{ endedAtMs: clock(10) }],
    },
  });
});

test('captures a verified redirect continuation after the previously waiting guest registers', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  await expect(
    observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }),
  ).resolves.toMatchObject({ status: 'waiting' });
  await expect(
    observer.apply(
      owner,
      {
        lease,
        sequence: 2,
        action: 'setTarget',
        page: page.page,
        requestedAtMs: clock(0),
      },
      page,
    ),
  ).resolves.toMatchObject({ status: 'ready' });

  position(5);
  sendRequest(observer, page, 'continuation', 1, { redirectResponse: { status: 302 } });
  endRequest(observer, page, 'continuation', 4);
  const result = await observer.apply(owner, {
    lease,
    sequence: 3,
    action: 'finish',
    requestedAtMs: clock(5),
  });
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: [{ type: 'fetch', path: '/orders', status: 200 }],
      coverage: [],
    },
  });
});

test('retains distinct query values at the same API up to the overall capture limit', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);
  position(100);
  const searches = Array.from({ length: 20 }, (_, index) => `?page=${index + 1}`);
  for (const [index, search] of searches.entries()) {
    const id = `page-${index}`;
    sendRequest(observer, page, id, index * 2 + 1, {
      request: { url: `https://api.example.test/orders${search}`, method: 'GET' },
    });
    endRequest(observer, page, id, index * 2 + 1);
  }
  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(100),
  });
  expect(result).toMatchObject({ status: 'finished', snapshot: { coverage: [], omittedCount: 0 } });
  if (result.status === 'finished')
    expect(result.snapshot.entries.map(entry => entry.search)).toEqual(searches);
});

test('keeps later API evidence through static resource and polling volume', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);
  position(100);
  for (let index = 0; index < RECORDING_NETWORK_LIMITS.entries + 10; index++) {
    const requestId = `asset-${index}`;
    sendRequest(observer, page, requestId, 1, { type: 'Image' });
    observer.observe(page.guest, 'Network.loadingFinished', {
      requestId,
      timestamp: cdptime(2),
      encodedDataLength: 1,
    });
    sendRequest(observer, page, `poll-${index}`, 5, {
      request: { url: `https://api.example.test/status?timestamp=${index}`, method: 'GET' },
    });
    endRequest(observer, page, `poll-${index}`, 6);
  }
  sendRequest(observer, page, 'save', 90, {
    request: { url: 'https://api.example.test/save', method: 'POST' },
  });
  endRequest(observer, page, 'save', 95);

  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(100),
  });
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: expect.arrayContaining([expect.objectContaining({ path: '/save', method: 'POST' })]),
    },
  });
  if (result.status === 'finished') {
    expect(result.snapshot).not.toHaveProperty('resources');
    expect(result.snapshot.entries).toHaveLength(RECORDING_NETWORK_LIMITS.entries);
    expect(result.snapshot.omittedCount).toBeGreaterThan(0);
  }
});

test('evicts repeated successful polls before a distinct read at the capture limit', async () => {
  const observer = new BrowserRecordingNetworkObserver();
  const page = target(1, 'https://site.example.test/');
  await observer.apply(owner, { lease, sequence: 1, action: 'start', page: page.page }, page);
  position(100);
  for (let index = 0; index < RECORDING_NETWORK_LIMITS.entries; index++) {
    sendRequest(observer, page, `poll-${index}`, 5);
    endRequest(observer, page, `poll-${index}`, 6);
  }
  sendRequest(observer, page, 'filtered', 70, {
    request: { url: 'https://api.example.test/orders?filter=open', method: 'GET' },
  });
  endRequest(observer, page, 'filtered', 71);
  sendRequest(observer, page, 'last-poll', 80);
  endRequest(observer, page, 'last-poll', 81);

  const result = await observer.apply(owner, {
    lease,
    sequence: 2,
    action: 'finish',
    requestedAtMs: clock(100),
  });
  expect(result).toMatchObject({
    status: 'finished',
    snapshot: {
      entries: expect.arrayContaining([
        expect.objectContaining({ path: '/orders', search: '?filter=open' }),
      ]),
      omittedCount: 2,
    },
  });
});
