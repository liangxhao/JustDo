import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { BrowserIpc } from '../../../shared/browser/browser';
import { type BrowserAgentActionsContext, executeAct } from './browserAgentActions';
import { browserScopeId, type RegisteredTab } from './browserAgentProtocol';

const documents: JSDOM[] = [];
afterEach(() => documents.splice(0).forEach(document => document.window.close()));

const createActions = (headless = true) => {
  let cancelled = false;
  const assertActive = () => {
    if (cancelled) throw new Error('cancelled');
  };
  const dom = new JSDOM('<input id="input"><button id="button">Submit</button>', {
    runScripts: 'outside-only',
    url: 'https://example.com/',
  });
  documents.push(dom);
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  dom.window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 100, height: 40 }) as DOMRect;
  const sendCommand = vi.fn(async (_method: string, _parameters?: Record<string, unknown>) => {});
  const guest = {
    id: 7,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/',
    sendInputEvent: vi.fn(),
  };
  const tab: RegisteredTab = {
    sessionId: 'session-1',
    targetId: 'page-1',
    webContentsId: 7,
    profile: 'embedded',
    ownerId: 10,
    headless,
  };
  const context = {
    resolveTab: vi.fn(() => tab),
    navigationGenerations: new Map(),
    blockedDialogResult: vi.fn(() => null),
    waitForPossibleNavigation: vi.fn(async () => null),
    snapshots: new Map(),
    resolveActElement: vi.fn((request: Record<string, unknown>) => ({
      expression: `document.querySelector(${JSON.stringify(request.selector ?? '#input')})`,
      label: String(request.selector ?? '#input'),
      frameSelector: '',
    })),
    executeInTargetWorld: vi.fn(async (_tab, _guest, _frame, code) => dom.window.eval(code)),
    resolveTargetFrameOffset: vi.fn(async () => ({ x: 5, y: 10 })),
    waitWhileActive: vi.fn(async (_milliseconds: number, check: () => void) => check()),
    focusGuestForKeyboardInput: vi.fn(),
    enableDebuggerDomains: vi.fn(async () => ({ sendCommand })),
    sendToRenderer: vi.fn(),
    discardTabRuntime: vi.fn(),
    removeRegisteredTab: vi.fn(),
    closeTab: vi.fn(async () => {}),
  };
  const fullContext = context as unknown as BrowserAgentActionsContext;
  Object.assign(fullContext, { executeAct: executeAct.bind(fullContext) });
  const act = (request: Record<string, unknown>) =>
    executeAct.call(
      fullContext,
      request,
      tab,
      guest as unknown as Electron.WebContents,
      'session-1',
      'embedded',
      false,
      assertActive,
    );
  return {
    act,
    context,
    sendCommand,
    guest,
    tab,
    dom,
    cancel: () => (cancelled = true),
  };
};

describe('background browser actions', () => {
  test('keeps foreground keyboard input on the existing path', async () => {
    const { act, context, guest } = createActions(false);

    await act({ kind: 'press', key: 'Enter' });

    expect(context.focusGuestForKeyboardInput).toHaveBeenCalledWith(guest);
    expect(guest.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode: 'Enter', modifiers: [] }],
      [{ type: 'keyUp', keyCode: 'Enter', modifiers: [] }],
    ]);
    expect(context.enableDebuggerDomains).not.toHaveBeenCalled();
  });

  test('types Chinese into the selected element and submits without native focus', async () => {
    const { act, context, dom, sendCommand, guest } = createActions();
    const input = dom.window.document.querySelector('input')!;
    const changed = vi.fn();
    input.addEventListener('input', changed);

    await act({ kind: 'type', selector: '#input', text: '中文与 emoji 🙂', submit: true });

    expect(input.value).toBe('中文与 emoji 🙂');
    expect(changed).toHaveBeenCalledOnce();
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        text: '\r',
      }),
    );
    expect(sendCommand).toHaveBeenLastCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({
        type: 'keyUp',
        key: 'Enter',
      }),
    );
    expect(context.focusGuestForKeyboardInput).not.toHaveBeenCalled();
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
  });

  test('cancels slow typing before the next character or submission', async () => {
    const fixture = createActions();
    fixture.context.waitWhileActive.mockImplementation(async () => fixture.cancel());

    await expect(
      fixture.act({
        kind: 'type',
        selector: '#input',
        text: '中文',
        slowly: true,
        submit: true,
      }),
    ).rejects.toThrow('cancelled');

    expect(fixture.dom.window.document.querySelector('input')!.value).toBe('中');
    expect(fixture.sendCommand).not.toHaveBeenCalled();
  });

  test('uses frame-adjusted CDP hover and element clicks without foreground input', async () => {
    const { act, sendCommand, guest } = createActions();

    await act({ kind: 'hover', selector: '#button' });
    await act({ kind: 'click', selector: '#button', modifiers: ['Control'], doubleClick: true });

    expect(sendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 65,
      y: 50,
      button: 'none',
      buttons: 0,
      modifiers: 0,
    });
    const down = sendCommand.mock.calls
      .map(([, parameters]) => parameters)
      .filter(parameters => parameters?.type === 'mousePressed');
    expect(down).toEqual(
      [1, 2].map(clickCount => ({
        type: 'mousePressed',
        x: 65,
        y: 50,
        button: 'left',
        buttons: 1,
        modifiers: 2,
        clickCount,
      })),
    );
    expect(guest.sendInputEvent).not.toHaveBeenCalled();
  });

  test('releases a cancelled coordinate click and does not run another batch action', async () => {
    const fixture = createActions();
    fixture.context.waitWhileActive.mockImplementation(async () => fixture.cancel());

    await expect(
      fixture.act({
        kind: 'batch',
        stopOnError: false,
        actions: [
          { kind: 'clickCoords', x: 10, y: 20, delayMs: 100 },
          { kind: 'press', key: 'Enter' },
        ],
      }),
    ).rejects.toThrow('cancelled');

    expect(fixture.sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 10,
      y: 20,
      button: 'left',
      buttons: 0,
      modifiers: 0,
      clickCount: 1,
    });
    expect(fixture.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchKeyEvent',
      expect.anything(),
    );
  });

  test('keeps nested batch actions on their selected target', async () => {
    const fixture = createActions();
    fixture.context.resolveTab.mockReturnValue({ ...fixture.tab, targetId: 'other-page' });

    const result = await fixture.act({
      kind: 'batch',
      actions: [{ kind: 'press', key: 'Enter', targetId: 'other-page' }],
    });

    expect(result).toMatchObject({
      results: [{ ok: false, error: expect.stringContaining('targetId') }],
    });
    expect(fixture.sendCommand).not.toHaveBeenCalled();
    expect(fixture.guest.sendInputEvent).not.toHaveBeenCalled();
  });

  test('closes a background page through its Main host and cleans its registry', async () => {
    const { act, context, tab } = createActions();

    await expect(act({ kind: 'close' })).resolves.toEqual({ closed: true });

    expect(context.closeTab).toHaveBeenCalledWith(tab);
    expect(context.sendToRenderer).not.toHaveBeenCalled();
    expect(context.discardTabRuntime).toHaveBeenCalledWith(tab);
    expect(context.removeRegisteredTab).toHaveBeenCalledWith(
      browserScopeId('session-1', 'embedded'),
      'page-1',
    );
  });

  test('preserves foreground close notification', async () => {
    const { act, context } = createActions(false);

    await act({ kind: 'close' });

    expect(context.closeTab).not.toHaveBeenCalled();
    expect(context.sendToRenderer).toHaveBeenCalledWith(BrowserIpc.AgentCloseTab, {
      sessionId: 'session-1',
      targetId: 'page-1',
    });
  });
});
