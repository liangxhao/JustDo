import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type BrowserAgentActionsContext,
  executeOnGuest,
  setFileInputFiles,
} from './browserAgentActions';
import {
  type AgentBrowserCommand,
  type BrowserDialogResponse,
  type BrowserDialogState,
  type RegisteredTab,
} from './browserAgentProtocol';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const createActions = () => {
  let cancelled = false;
  const assertActive = () => {
    if (cancelled) throw new Error('cancelled');
  };
  const guest = { id: 7 } as Electron.WebContents;
  const tab: RegisteredTab = {
    sessionId: 'session-1',
    targetId: 'page-1',
    webContentsId: 7,
    profile: 'embedded',
    ownerId: -1,
    headless: true,
  };
  const sendCommand = vi.fn(
    async (_method: string, _parameters?: Record<string, unknown>): Promise<unknown> => undefined,
  );
  const guestDebugger = { sendCommand } as unknown as Electron.Debugger;
  const dialogs = new Map<number, BrowserDialogState>();
  const armedDialogs = new Map<number, BrowserDialogResponse>();
  const context = {
    enableDebuggerDomains: vi.fn(async () => guestDebugger),
    armUpload: vi.fn(
      async (
        _tab: RegisteredTab,
        _guest: Electron.WebContents,
        _files: string[],
        _assertActive?: () => void,
      ) => ({ completion: Promise.resolve() }),
    ),
    clearArmedUpload: vi.fn(),
    executeInTargetWorld: vi.fn(async (): Promise<unknown> => true),
    assertCurrentRef: vi.fn(() => ({
      expression: 'document.querySelector("#file")',
      worldFrameSelector: '',
      frameSelector: '',
      ref: 'e1',
      index: 0,
      snapshotId: 'snapshot',
      aria: false,
    })),
    resolveUploadPaths: vi.fn((_sessionId: string, files: unknown) => files as string[]),
    setFileInputFiles: vi.fn(async () => {}),
    executeAct: vi.fn(async () => ({})),
    dialogs,
    armedDialogs,
    clearArmedDialog: vi.fn((id: number) => {
      const previous = armedDialogs.get(id);
      if (previous) clearTimeout(previous.timer);
      armedDialogs.delete(id);
      return previous;
    }),
  };
  const fullContext = context as unknown as BrowserAgentActionsContext;
  return {
    context,
    sendCommand,
    guestDebugger,
    assertActive,
    cancel: () => {
      cancelled = true;
    },
    upload: (options: Partial<AgentBrowserCommand> = {}) =>
      setFileInputFiles.call(
        fullContext,
        { sessionKey: 'native-fixture', action: 'upload', ...options },
        tab,
        guest,
        ['fixture.txt'],
        tab.sessionId,
        'embedded',
        assertActive,
      ),
    execute: (command: AgentBrowserCommand) =>
      executeOnGuest.call(
        fullContext,
        command,
        tab,
        guest,
        assertActive,
        tab.sessionId,
        'embedded',
      ),
  };
};

describe('upload cancellation admission', () => {
  test.each([{}, { element: '#file' }, { ref: 'e1' }])(
    'does not arm or mutate an upload cancelled during debugger preparation: %j',
    async options => {
      const fixture = createActions();
      const ready = deferred<Electron.Debugger>();
      fixture.context.enableDebuggerDomains.mockReturnValue(ready.promise);
      const pending = fixture.upload(options);
      fixture.cancel();
      ready.resolve(fixture.guestDebugger);

      await expect(pending).rejects.toThrow('cancelled');

      expect(fixture.context.armUpload).not.toHaveBeenCalled();
      expect(fixture.context.assertCurrentRef).not.toHaveBeenCalled();
      expect(fixture.context.executeInTargetWorld).not.toHaveBeenCalled();
      expect(fixture.sendCommand).not.toHaveBeenCalled();
    },
  );

  test('retains the live operation guard on an upload armed for a later call', async () => {
    const fixture = createActions();

    await fixture.upload();

    const guard = fixture.context.armUpload.mock.calls[0]![3];
    expect(guard).toBe(fixture.assertActive);
    expect(() => guard!()).not.toThrow();
    fixture.cancel();
    expect(() => guard!()).toThrow('cancelled');
  });

  test.each([
    'DOM.getDocument',
    'DOM.performSearch',
    'DOM.getSearchResults',
    'DOM.setFileInputFiles',
  ])(
    'checks cancellation after %s and still cleans the original search and marker',
    async suspended => {
      const fixture = createActions();
      const replied = deferred<unknown>();
      fixture.sendCommand.mockImplementation(async method => {
        if (method === suspended) return replied.promise;
        if (method === 'DOM.performSearch') return { searchId: 'search-1', resultCount: 1 };
        if (method === 'DOM.getSearchResults') return { nodeIds: [42] };
      });
      const pending = fixture.upload({ element: '#file' });
      await vi.waitFor(() =>
        expect(fixture.sendCommand).toHaveBeenCalledWith(suspended, expect.anything()),
      );
      fixture.cancel();
      replied.resolve(
        suspended === 'DOM.performSearch'
          ? { searchId: 'search-1', resultCount: 1 }
          : suspended === 'DOM.getSearchResults'
            ? { nodeIds: [42] }
            : undefined,
      );

      await expect(pending).rejects.toThrow('cancelled');

      if (suspended !== 'DOM.getDocument') {
        expect(fixture.sendCommand).toHaveBeenCalledWith('DOM.discardSearchResults', {
          searchId: 'search-1',
        });
      } else {
        expect(fixture.sendCommand).not.toHaveBeenCalledWith(
          'DOM.performSearch',
          expect.anything(),
        );
      }
      if (suspended !== 'DOM.setFileInputFiles') {
        expect(fixture.sendCommand).not.toHaveBeenCalledWith(
          'DOM.setFileInputFiles',
          expect.anything(),
        );
      }
      expect(fixture.context.executeInTargetWorld).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        '',
        expect.stringContaining('removeAttribute'),
      );
    },
  );

  test('does not report a direct upload success when it was cancelled at completion', async () => {
    const fixture = createActions();
    const uploaded = deferred<void>();
    fixture.context.setFileInputFiles.mockReturnValue(uploaded.promise);
    const pending = fixture.execute({
      sessionKey: 'native-fixture',
      action: 'upload',
      paths: ['fixture.txt'],
    });
    fixture.cancel();
    uploaded.resolve(undefined);

    await expect(pending).rejects.toThrow('cancelled');
  });
});

describe('dialog cancellation admission', () => {
  const pendingDialog: BrowserDialogState = { id: 'dialog-1', type: 'prompt', message: 'fixture' };

  test('does not accept a dialog after cancellation during debugger preparation', async () => {
    const fixture = createActions();
    fixture.context.dialogs.set(7, pendingDialog);
    const ready = deferred<Electron.Debugger>();
    fixture.context.enableDebuggerDomains.mockReturnValue(ready.promise);
    const pending = fixture.execute({
      sessionKey: 'native-fixture',
      action: 'dialog',
      accept: true,
    });
    fixture.cancel();
    ready.resolve(fixture.guestDebugger);

    await expect(pending).rejects.toThrow('cancelled');

    expect(fixture.sendCommand).not.toHaveBeenCalled();
    expect(fixture.context.dialogs.get(7)).toBe(pendingDialog);
  });

  test('does not handle a replacement dialog created while the debugger was preparing', async () => {
    const fixture = createActions();
    fixture.context.dialogs.set(7, pendingDialog);
    const ready = deferred<Electron.Debugger>();
    fixture.context.enableDebuggerDomains.mockReturnValue(ready.promise);
    const pending = fixture.execute({
      sessionKey: 'native-fixture',
      action: 'dialog',
      accept: true,
    });
    const replacement = { ...pendingDialog, id: 'dialog-2' };
    fixture.context.dialogs.set(7, replacement);
    ready.resolve(fixture.guestDebugger);

    await expect(pending).rejects.toThrow('stale');

    expect(fixture.sendCommand).not.toHaveBeenCalled();
    expect(fixture.context.dialogs.get(7)).toBe(replacement);
  });

  test('does not report dialog success after cancellation during its native reply', async () => {
    const fixture = createActions();
    fixture.context.dialogs.set(7, pendingDialog);
    const handled = deferred<unknown>();
    fixture.sendCommand.mockReturnValue(handled.promise);
    const pending = fixture.execute({
      sessionKey: 'native-fixture',
      action: 'dialog',
      accept: true,
    });
    await vi.waitFor(() =>
      expect(fixture.sendCommand).toHaveBeenCalledWith(
        'Page.handleJavaScriptDialog',
        expect.anything(),
      ),
    );
    fixture.cancel();
    handled.resolve(undefined);

    await expect(pending).rejects.toThrow('cancelled');
    expect(fixture.context.dialogs.get(7)).toBe(pendingDialog);
  });

  test('keeps a replacement dialog when the original native response completes', async () => {
    const fixture = createActions();
    fixture.context.dialogs.set(7, pendingDialog);
    const handled = deferred<unknown>();
    fixture.sendCommand.mockReturnValue(handled.promise);
    const pending = fixture.execute({
      sessionKey: 'native-fixture',
      action: 'dialog',
      accept: true,
    });
    await vi.waitFor(() => expect(fixture.sendCommand).toHaveBeenCalled());
    const replacement = { ...pendingDialog, id: 'dialog-2' };
    fixture.context.dialogs.set(7, replacement);
    handled.resolve(undefined);

    await expect(pending).resolves.toMatchObject({ ok: true, dialogId: 'dialog-1' });
    expect(fixture.context.dialogs.get(7)).toBe(replacement);
  });

  test('retains a guard for an armed dialog without invalidating normal cross-call use', async () => {
    vi.useFakeTimers();
    const fixture = createActions();

    await expect(
      fixture.execute({ sessionKey: 'native-fixture', action: 'dialog', accept: true }),
    ).resolves.toMatchObject({ armed: true });

    const armed = fixture.context.armedDialogs.get(7)!;
    expect(armed.assertActive).toBe(fixture.assertActive);
    expect(() => armed.assertActive!()).not.toThrow();
    fixture.cancel();
    expect(() => armed.assertActive!()).toThrow('cancelled');
  });
});
