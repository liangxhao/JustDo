// @vitest-environment jsdom
import type { BrowserPanelTab } from '@shared/browser/browser';
import { BrowserRecordingChannel } from '@shared/browser/browserRecording';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBrowserRecording } from './useBrowserRecording';

afterEach(() => vi.restoreAllMocks());
function setup() {
  const lease = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { setRecordingLease: lease } },
  });
  const tab = {
    targetId: 'tab-1',
    url: 'https://example.com/',
    title: 'Orders',
    profile: 'embedded',
  } as BrowserPanelTab;
  let deliver: ReturnType<typeof useBrowserRecording>['onMessage'] = () => {};
  const guest = Object.assign(document.createElement('div'), {
    getURL: () => tab.url,
    capturePage: vi.fn(),
    send: vi.fn((channel: string, ...args: unknown[]) => {
      const control = args[0] as { recordingId: string; active: boolean };
      if (channel === BrowserRecordingChannel.Control)
        deliver(tab.targetId, BrowserRecordingChannel.Ready, {
          ...control,
          documentId: 'doc-1',
        });
    }),
  });
  const options = {
    draftKey: 'session',
    isOpen: true,
    activeTab: tab,
    tabs: [tab],
    guests: { current: new Map([[tab.targetId, guest]]) },
  };
  const hook = renderHook(props => useBrowserRecording(props), { initialProps: options });
  deliver = (...args) => hook.result.current.onMessage(...args);
  return { ...hook, lease, tab, guest, options };
}
describe('browser recording lifecycle', () => {
  it('removes screenshot evidence belonging to a click replaced by a double click', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    const recordingId = view.result.current.session!.id;
    const target = { tag: 'button', name: 'Open', role: 'button', selector: '#open' };
    act(() => {
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 1,
        action: 'click',
        target,
      });
    });
    act(() => {
      const session = view.result.current.session!;
      view.result.current.update({
        ...session,
        steps: session.steps.map(step =>
          step.id === 'doc-1:1' ? { ...step, screenshotIssue: 'failed' } : step,
        ),
        screenshotWarning: true,
        images: [
          { stepId: 'doc-1:1', fileName: 'old.jpg', dataUrl: 'data:image/jpeg;base64,AA==' },
        ],
      });
    });
    act(() =>
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 2,
        action: 'doubleClick',
        target,
      }),
    );
    expect(view.result.current.session!.steps.map(step => step.action)).toEqual([
      'openTab',
      'doubleClick',
    ]);
    expect(view.result.current.session!.images).toEqual([]);
    expect(view.result.current.session!.screenshotWarning).toBe(false);
    view.unmount();
  });
  it('does not coalesce targets with the same selector in different frames', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    act(() => {
      for (const [index, action] of ['click', 'doubleClick'].entries()) {
        view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
          recordingId: view.result.current.session!.id,
          documentId: 'doc-1',
          sequence: index + 1,
          action,
          target: {
            tag: 'button',
            name: 'Open',
            role: 'button',
            selector: '#open',
            scopes: [{ kind: 'frame', selector: `#frame-${index}` }],
          },
        });
      }
    });
    expect(view.result.current.session!.steps.map(step => step.action)).toEqual([
      'openTab',
      'click',
      'doubleClick',
    ]);
    view.unmount();
  });
  it.each(['pause', 'stop'] as const)('ignores late observed outcomes after %s', async action => {
    const view = setup();
    await act(() => view.result.current.start());
    const recordingId = view.result.current.session!.id;
    act(() =>
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 1,
        action: 'click',
      }),
    );
    await act(() => view.result.current[action]());
    const finalized = view.result.current.session;
    act(() =>
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 2,
        relatedSequence: 1,
        action: 'observe',
        interaction: { observed: { messages: ['Late update'] } },
      }),
    );
    expect(view.result.current.session).toBe(finalized);
    view.unmount();
  });
  it('attaches observed changes to their source step instead of adding a new action', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    const recordingId = view.result.current.session!.id;
    act(() => {
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 1,
        action: 'click',
        target: { tag: 'button', name: 'Open', role: 'button', selector: '#open' },
      });
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 2,
        relatedSequence: 1,
        action: 'observe',
        interaction: { observed: { state: { expanded: 'true' } } },
      });
    });
    expect(view.result.current.session!.steps).toHaveLength(2);
    expect(view.result.current.session!.steps[1].interaction?.observed?.state).toEqual({
      expanded: 'true',
    });
    act(() => {
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId,
        documentId: 'doc-1',
        sequence: 3,
        relatedSequence: 99,
        action: 'observe',
        interaction: { observed: { messages: ['Unrelated'] } },
      });
    });
    expect(view.result.current.session!.steps[1].interaction?.observed?.messages).toBeUndefined();
    view.unmount();
  });
  it('transfers only explicit session promotions while releasing the original Main lease', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    await act(() => view.result.current.pause());
    act(() => view.result.current.promoteSession('session', 'temp-1'));
    view.rerender({ ...view.options, draftKey: 'temp-1' });
    act(() => view.result.current.promoteSession('temp-1', 'canonical'));
    view.rerender({ ...view.options, draftKey: 'canonical' });
    act(() => view.result.current.resume());
    expect(view.result.current.session).toMatchObject({
      sessionId: 'canonical',
      status: 'recording',
    });
    await act(() => view.result.current.stop());
    expect(view.lease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        acquire: false,
        sessionId: 'session',
      }),
    );
    view.unmount();
  });
  it('cancels an in-flight start on explicit promotion and releases its granted lease', async () => {
    const view = setup();
    let grant!: (value: boolean) => void;
    view.lease.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        grant = resolve;
      }),
    );
    let start!: Promise<void>;
    act(() => {
      start = view.result.current.start();
    });
    act(() => view.result.current.promoteSession('session', 'canonical'));
    await act(async () => {
      grant(true);
      await start;
    });
    expect(view.result.current.session).toBeNull();
    expect(view.lease).toHaveBeenLastCalledWith(
      expect.objectContaining({
        acquire: false,
        sessionId: 'session',
      }),
    );
    view.unmount();
  });
  it('starts on the current tab after waiting for the protection lease', async () => {
    const view = setup();
    let grant!: (value: boolean) => void;
    view.lease.mockReturnValue(
      new Promise<boolean>(resolve => {
        grant = resolve;
      }),
    );
    let start!: Promise<void>;
    act(() => {
      start = view.result.current.start();
    });
    const nextTab = { ...view.tab, targetId: 'tab-2', url: 'https://example.com/next' };
    view.rerender({ ...view.options, activeTab: nextTab, tabs: [view.tab, nextTab] });
    await act(async () => {
      grant(true);
      await start;
    });
    expect(view.result.current.session?.steps[0]).toMatchObject({
      action: 'openTab',
      pageId: 'tab-2',
      url: nextTab.url,
    });
    view.unmount();
  });
  it('does not wait for a closed guest or falsely mark its completed drain incomplete', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    const nextTab = { ...view.tab, targetId: 'tab-2' };
    const nextGuest = Object.assign(document.createElement('div'), {
      getURL: () => nextTab.url,
      capturePage: vi.fn(),
      send: vi.fn((channel: string, control: unknown) => {
        if (channel === BrowserRecordingChannel.Control)
          view.result.current.onMessage('tab-2', BrowserRecordingChannel.Ready, {
            ...(control as object),
            documentId: 'doc-2',
          });
      }),
    });
    view.options.guests.current.set('tab-2', nextGuest);
    await act(async () => {
      view.rerender({ ...view.options, activeTab: nextTab, tabs: [view.tab, nextTab] });
    });
    await act(() => view.result.current.drain());
    view.options.guests.current.delete('tab-1');
    await act(async () => {
      view.rerender({ ...view.options, activeTab: nextTab, tabs: [nextTab] });
    });
    await act(() => view.result.current.stop());
    expect(view.result.current.session?.incomplete).not.toBe(true);
    expect(view.result.current.session?.steps.some(step => step.action === 'closeTab')).toBe(true);
    view.unmount();
  });
  it('serializes concurrent pause and stop around the same guest flush', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    await act(async () => {
      await Promise.all([view.result.current.pause(), view.result.current.stop()]);
    });
    expect(view.result.current.session?.status).toBe('review');
    expect(view.result.current.session?.incomplete).not.toBe(true);
    view.unmount();
  });
  it('invalidates a pending tab switch when a different profile is selected before drain ACK', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    let pendingControl: { recordingId: string; requestId: string; active: boolean } | undefined;
    view.guest.send.mockImplementation((channel: string, ...args: unknown[]) => {
      if (channel === BrowserRecordingChannel.Control) {
        const command = args[0] as typeof pendingControl;
        if (command?.requestId) pendingControl = command;
      }
    });
    const nextTab = { ...view.tab, targetId: 'tab-2' };
    const otherProfileTab = {
      ...view.tab,
      targetId: 'tab-3',
      profile: 'isolated',
    } as BrowserPanelTab;
    view.rerender({
      ...view.options,
      activeTab: nextTab,
      tabs: [view.tab, nextTab, otherProfileTab],
    });
    expect(pendingControl).toBeDefined();
    view.rerender({
      ...view.options,
      activeTab: otherProfileTab,
      tabs: [view.tab, nextTab, otherProfileTab],
    });
    await act(async () => {
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Ready, {
        ...pendingControl,
        documentId: 'doc-1',
      });
    });
    expect(view.result.current.session?.status).toBe('paused');
    expect(view.result.current.session?.steps.map(step => step.pageId)).toEqual(['tab-1']);
    view.unmount();
  });
  it('records reloads even when the address remains unchanged', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    act(() => view.result.current.onNavigation('tab-1', view.tab.url));
    expect(view.result.current.session?.steps.map(step => step.action)).toEqual([
      'openTab',
      'navigate',
    ]);
    view.unmount();
  });
  it('does not copy the previous page title onto a navigation step', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    act(() => view.result.current.onNavigation('tab-1', 'https://example.com/next?q=hello'));
    expect(view.result.current.session?.steps.slice(-1)[0]).toMatchObject({
      title: '',
      url: 'https://example.com/next?q=hello',
    });
    view.unmount();
  });
  it('explains password-blocked captures on the affected step', async () => {
    vi.useFakeTimers();
    const view = setup();
    try {
      await act(() => view.result.current.start());
      const original = view.guest.send.getMockImplementation()!;
      view.guest.send.mockImplementation((channel, ...args) => {
        if (channel === BrowserRecordingChannel.Capture) {
          view.result.current.onMessage('tab-1', channel, {
            requestId: args[0],
            documentId: 'doc-1',
            safe: false,
            revision: 0,
          });
        } else original(channel, ...args);
      });
      await act(() => vi.advanceTimersByTimeAsync(601));
      expect(view.guest.capturePage).not.toHaveBeenCalled();
      expect(view.result.current.session?.steps[0].screenshotIssue).toBe('password');
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  it('stores a screenshot for a safe page and captures completed input steps', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        width = 1600;
        height = 900;
        decode() {
          return Promise.resolve();
        }
      },
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,AA==',
    );
    const view = setup();
    try {
      await act(() => view.result.current.start());
      view.guest.capturePage.mockResolvedValue({ toDataURL: () => 'data:image/png;base64,AA==' });
      const original = view.guest.send.getMockImplementation()!;
      view.guest.send.mockImplementation((channel, ...args) => {
        if (channel === BrowserRecordingChannel.Capture)
          view.result.current.onMessage('tab-1', channel, {
            requestId: args[0],
            documentId: 'doc-1',
            safe: true,
            revision: 0,
          });
        else original(channel, ...args);
      });
      await act(() => vi.advanceTimersByTimeAsync(601));
      expect(view.result.current.session?.images).toHaveLength(1);
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 720);
      act(() =>
        view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
          recordingId: view.result.current.session!.id,
          documentId: 'doc-1',
          sequence: 1,
          action: 'input',
          value: 'hello',
        }),
      );
      await act(() => vi.advanceTimersByTimeAsync(601));
      expect(view.result.current.session?.images).toHaveLength(2);
      expect(view.result.current.session?.screenshotWarning).toBe(false);
    } finally {
      view.unmount();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('acquires protection before recording, accepts current document events and rejects stale ones', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    const id = view.result.current.session!.id;
    expect(view.lease).toHaveBeenCalledWith(
      expect.objectContaining({ acquire: true, recordingId: id }),
    );
    act(() => {
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId: id,
        documentId: 'old-doc',
        sequence: 1,
        action: 'input',
        value: 'wrong',
      });
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId: id,
        documentId: 'doc-1',
        sequence: 1,
        action: 'input',
        value: '123',
      });
      view.result.current.onMessage('tab-1', BrowserRecordingChannel.Event, {
        recordingId: id,
        documentId: 'doc-1',
        sequence: 1,
        action: 'input',
        value: 'duplicate',
      });
    });
    expect(view.result.current.session!.steps.map(s => s.value).filter(Boolean)).toEqual(['123']);
    await act(() => view.result.current.stop());
    expect(view.result.current.session?.status).toBe('review');
    expect(view.lease).toHaveBeenLastCalledWith(expect.objectContaining({ acquire: false }));
    view.unmount();
  });
  it('keeps protection while paused and adds an explicit gap on resume', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    await act(() => view.result.current.pause());
    expect(view.result.current.session?.status).toBe('paused');
    expect(view.lease).toHaveBeenCalledTimes(1);
    act(() => view.result.current.resume());
    expect(view.result.current.session?.steps.map(s => s.action)).toEqual(['openTab', 'gap']);
    view.unmount();
    expect(view.lease).toHaveBeenLastCalledWith(expect.objectContaining({ acquire: false }));
  });
  it('pauses when hidden and retains original session ownership', async () => {
    const view = setup();
    await act(() => view.result.current.start());
    view.rerender({ ...view.options, draftKey: 'other-session', isOpen: false });
    await waitFor(() => expect(view.result.current.session?.status).toBe('paused'));
    expect(view.result.current.session?.sessionId).toBe('session');
    view.unmount();
  });
  it('does not collect anything when Main rejects protection', async () => {
    const view = setup();
    view.lease.mockResolvedValue(false);
    await act(() => view.result.current.start());
    expect(view.result.current.session).toBeNull();
    expect(view.result.current.failed).toBe(true);
    expect(view.guest.send).not.toHaveBeenCalled();
    view.unmount();
  });
});
