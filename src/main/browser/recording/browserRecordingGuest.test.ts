// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ipc = vi.hoisted(() => ({
  callbacks: new Map<string, (...args: unknown[]) => void>(),
  sendToHost: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcRenderer: {
    on: (channel: string, handler: (...args: unknown[]) => void) =>
      ipc.callbacks.set(channel, handler),
    sendToHost: ipc.sendToHost,
  },
}));
import { BrowserRecordingChannel } from '../../../shared/browser/browserRecording';
import { installBrowserRecordingGuest } from './browserRecordingGuest';

describe('guest action observation', () => {
  afterEach(() => {
    ipc.callbacks.get(BrowserRecordingChannel.Control)?.(null, { recordingId: 'r', active: false });
    vi.useRealTimers();
  });
  const listeners = new Map<string, EventListener>();
  beforeEach(() => {
    vi.restoreAllMocks();
    listeners.clear();
    ipc.sendToHost.mockClear();
    ipc.callbacks.clear();
    document.body.innerHTML = '';
    vi.spyOn(document, 'addEventListener').mockImplementation((name, handler) => {
      listeners.set(name, handler as EventListener);
    });
    installBrowserRecordingGuest();
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: true });
  });
  const send = (name: string, element: Element, trusted = true) =>
    listeners.get(name)!({
      isTrusted: trusted,
      composedPath: () => [element],
      detail: 1,
    } as unknown as Event);
  it('records focused targets and keyboard modifiers without password values', () => {
    document.body.innerHTML = '<input name="query"><input type="password">';
    listeners.get('keydown')!({
      isTrusted: true,
      key: 'a',
      ctrlKey: true,
      composedPath: () => [document.querySelector('input')],
    } as unknown as Event);
    const event = ipc.sendToHost.mock.calls
      .filter(call => call[0] === BrowserRecordingChannel.Event)
      .at(-1)![1];
    expect(event.value).toBe('Control+a');
    expect(event.target.name).toBe('query');
    expect(event.interaction.modifiers).toEqual(['Control']);
    listeners.get('keydown')!({
      isTrusted: true,
      key: 'a',
      ctrlKey: true,
      composedPath: () => [document.querySelector('[type=password]')],
    } as unknown as Event);
    const password = ipc.sendToHost.mock.calls
      .filter(call => call[0] === BrowserRecordingChannel.Event)
      .at(-1)![1];
    expect(password.sensitive).toBe(true);
    expect(password.value).toBeUndefined();
    expect(password.interaction).toBeUndefined();
  });
  it('records selection labels, values and indexes', () => {
    document.body.innerHTML =
      '<select multiple><option value="a" selected>Alpha</option><option value="b" selected>Beta</option></select>';
    send('change', document.querySelector('select')!);
    expect(
      ipc.sendToHost.mock.calls.filter(call => call[0] === BrowserRecordingChannel.Event).at(-1)![1]
        .interaction.options,
    ).toEqual([
      { label: 'Alpha', value: 'a', index: 0 },
      { label: 'Beta', value: 'b', index: 1 },
    ]);
  });
  it('ignores modifier-only key presses before recording the actual shortcut', () => {
    document.body.innerHTML = '<input name="query">';
    const input = document.querySelector('input')!;
    for (const key of ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'a']) {
      listeners.get('keydown')!({
        isTrusted: true,
        key,
        ctrlKey: true,
        composedPath: () => [input],
      } as unknown as Event);
    }
    const events = ipc.sendToHost.mock.calls.filter(
      call => call[0] === BrowserRecordingChannel.Event,
    );
    expect(events.map(call => call[1].value)).toEqual(['Control+a']);
  });
  it.each(['pause', 'click'])(
    'flushes the final scroll before %s without a delayed duplicate',
    action => {
      vi.useFakeTimers();
      document.body.innerHTML = '<div id="scroller"></div><button>Next</button>';
      const scroller = document.querySelector('#scroller')!;
      scroller.scrollTop = 700;
      send('wheel', scroller);
      send('scroll', scroller);
      if (action === 'pause')
        ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, {
          recordingId: 'r',
          active: false,
        });
      else send('click', document.querySelector('button')!);
      const events = () =>
        ipc.sendToHost.mock.calls
          .filter(call => call[0] === BrowserRecordingChannel.Event)
          .map(call => call[1]);
      expect(events().map(event => event.action)).toEqual(
        action === 'pause' ? ['scroll'] : ['scroll', 'click'],
      );
      expect(events()[0].value).toBe('0,700');
      vi.advanceTimersByTime(500);
      expect(events().filter(event => event.action === 'scroll')).toHaveLength(1);
    },
  );
  it('retains password identity when revealed before the first field interaction', async () => {
    document.body.innerHTML = '<input type="password">';
    const input = document.querySelector('input')!;
    input.value = 'revealed-secret';
    input.type = 'text';
    await Promise.resolve();
    send('input', input);
    send('focusout', input);
    const events = ipc.sendToHost.mock.calls.filter(
      call => call[0] === BrowserRecordingChannel.Event,
    );
    expect(events[0][1].sensitive).toBe(true);
    expect(JSON.stringify(events)).not.toContain('revealed-secret');
    vi.spyOn(input, 'getClientRects').mockReturnValue([
      { width: 100, height: 20 },
    ] as unknown as DOMRectList);
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'revealed');
    expect(ipc.sendToHost).toHaveBeenLastCalledWith(
      BrowserRecordingChannel.Capture,
      expect.objectContaining({ safe: false }),
    );
  });
  it('observes dynamically attached shadow controls without duplicating composed clicks', () => {
    const shadowListeners = new Map<string, EventListener>();
    vi.spyOn(ShadowRoot.prototype, 'addEventListener').mockImplementation((name, handler) => {
      shadowListeners.set(name, handler as EventListener);
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<select><option value="a">Alpha</option></select><button>Go</button>';
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: true });
    shadowListeners.get('change')!({
      isTrusted: true,
      composedPath: () => [root.querySelector('select')],
    } as unknown as Event);
    const click = {
      isTrusted: true,
      detail: 1,
      composedPath: () => [root.querySelector('button')],
    } as unknown as Event;
    listeners.get('click')!(click);
    shadowListeners.get('click')!(click);
    const events = ipc.sendToHost.mock.calls
      .filter(call => call[0] === BrowserRecordingChannel.Event)
      .map(call => call[1]);
    expect(events.map(e => e.action)).toEqual(['select', 'click']);
    expect(events[0].target.scopes[0].kind).toBe('shadow');
  });
  it('correlates a bounded post-click observation and flushes it before pause acknowledgement', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button aria-expanded="false">Open</button>';
    const button = document.querySelector('button')!;
    send('click', button);
    button.setAttribute('aria-expanded', 'true');
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: false });
    const events = ipc.sendToHost.mock.calls
      .filter(call => call[0] === BrowserRecordingChannel.Event)
      .map(call => call[1]);
    expect(events.map(e => e.action)).toEqual(['click', 'observe']);
    expect(events[1].relatedSequence).toBe(events[0].sequence);
    expect(events[1].interaction.observed.state).toEqual({ expanded: 'true' });
    expect(ipc.sendToHost.mock.calls.at(-1)![0]).toBe(BrowserRecordingChannel.Ready);
    const count = ipc.sendToHost.mock.calls.length;
    vi.runAllTimers();
    expect(ipc.sendToHost.mock.calls).toHaveLength(count);
  });
  it('records context menus and completed native drags but not cancelled drags', () => {
    document.body.innerHTML =
      '<div id="source" draggable="true">Drag</div><div id="dest">Drop</div>';
    const source = document.querySelector('#source')!;
    const dest = document.querySelector('#dest')!;
    send('contextmenu', source);
    send('dragstart', source);
    send('drop', dest);
    send('dragstart', source);
    send('dragend', source);
    send('drop', dest);
    const events = ipc.sendToHost.mock.calls
      .filter(call => call[0] === BrowserRecordingChannel.Event)
      .map(call => call[1]);
    expect(events.map(e => e.action)).toEqual(['contextMenu', 'drag']);
    expect(document.querySelector(events[1].interaction.destination)).toBe(dest);
  });
  it('records a meaningful hover expansion but ignores stale hover timers after pause', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button aria-haspopup="menu" aria-expanded="false">Menu</button>';
    const button = document.querySelector('button')!;
    send('pointerover', button);
    button.setAttribute('aria-expanded', 'true');
    vi.advanceTimersByTime(350);
    expect(
      ipc.sendToHost.mock.calls.filter(call => call[0] === BrowserRecordingChannel.Event).at(-1)![1]
        .action,
    ).toBe('hover');
    send('pointerover', button);
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: false });
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: true });
    const count = ipc.sendToHost.mock.calls.length;
    button.setAttribute('aria-expanded', 'false');
    vi.advanceTimersByTime(350);
    expect(ipc.sendToHost.mock.calls).toHaveLength(count);
  });
  it('merges edits and flushes final input before the pause acknowledgement', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.value = '1';
    send('input', input);
    input.value = '123';
    send('input', input);
    ipc.callbacks.get(BrowserRecordingChannel.Control)!(null, { recordingId: 'r', active: false });
    const events = ipc.sendToHost.mock.calls.filter(
      call => call[0] === BrowserRecordingChannel.Event,
    );
    expect(events).toHaveLength(1);
    expect(events[0][1].value).toBe('123');
    expect(ipc.sendToHost.mock.calls.slice(-1)[0][0]).toBe(BrowserRecordingChannel.Ready);
  });
  it('never transmits a password and ignores synthetic input', () => {
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    input.value = 'super-secret';
    send('input', input);
    send('focusout', input);
    expect(JSON.stringify(ipc.sendToHost.mock.calls)).not.toContain('super-secret');
    expect(ipc.sendToHost).toHaveBeenCalledWith(
      BrowserRecordingChannel.Event,
      expect.objectContaining({ sensitive: true }),
    );
    ipc.sendToHost.mockClear();
    input.type = 'text';
    send('input', input, false);
    send('focusout', input);
    expect(ipc.sendToHost).not.toHaveBeenCalled();
  });
  it.each(['cvv', 'CVC', 'card-pin', 'otp', 'token'])(
    'retains non-password fields named %s',
    name => {
      const input = document.createElement('input');
      input.name = name;
      input.value = '1234';
      document.body.append(input);
      send('input', input);
      send('focusout', input);
      expect(JSON.stringify(ipc.sendToHost.mock.calls)).toContain('1234');
      ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'payment');
      expect(ipc.sendToHost).toHaveBeenCalledWith(
        BrowserRecordingChannel.Capture,
        expect.objectContaining({ safe: true }),
      );
    },
  );
  it.each(['iframe', 'canvas', 'object', 'embed', 'video', 'private-payment'])(
    'does not suppress screenshots merely because %s content exists',
    tag => {
      const element = document.createElement(tag);
      if (tag === 'private-payment') {
        const root = element.attachShadow({ mode: 'closed' });
        root.innerHTML = '<input name="otp" value="123456">';
      }
      document.body.append(element);
      ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'private');
      expect(ipc.sendToHost).toHaveBeenCalledWith(
        BrowserRecordingChannel.Capture,
        expect.objectContaining({ safe: true }),
      );
    },
  );
  it('does not emit intermediate IME composition and allows OTP form screenshots', () => {
    const input = document.createElement('input');
    input.autocomplete = 'one-time-code';
    document.body.append(input);
    send('compositionstart', input);
    input.value = '中';
    send('input', input);
    send('focusout', input);
    expect(
      ipc.sendToHost.mock.calls.filter(call => call[0] === BrowserRecordingChannel.Event),
    ).toHaveLength(0);
    send('compositionend', input);
    send('focusout', input);
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'capture');
    expect(ipc.sendToHost).toHaveBeenCalledWith(
      BrowserRecordingChannel.Capture,
      expect.objectContaining({ safe: true }),
    );
  });
  it('blocks visible passwords but allows hidden login forms', () => {
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    const rects = vi.spyOn(input, 'getClientRects');
    rects.mockReturnValue([{ width: 100, height: 20 }] as unknown as DOMRectList);
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'visible');
    expect(ipc.sendToHost).toHaveBeenLastCalledWith(
      BrowserRecordingChannel.Capture,
      expect.objectContaining({ safe: false }),
    );
    rects.mockReturnValue([] as unknown as DOMRectList);
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'hidden');
    expect(ipc.sendToHost).toHaveBeenLastCalledWith(
      BrowserRecordingChannel.Capture,
      expect.objectContaining({ safe: true }),
    );
  });
  it('keeps a revealed password private and omits HTML and input values', () => {
    const input = document.createElement('input');
    input.type = 'password';
    input.value = 'private-value';
    document.body.append(input);
    send('click', input);
    input.type = 'text';
    send('input', input);
    send('focusout', input);
    const events = ipc.sendToHost.mock.calls.filter(
      call => call[0] === BrowserRecordingChannel.Event,
    );
    expect(events).toHaveLength(2);
    expect(events[1][1].sensitive).toBe(true);
    expect(events[1][1].target.html).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('private-value');
  });
  it('records distinct selectors and shallow HTML without descendant form values', () => {
    document.body.innerHTML =
      '<section><button>First</button><button data-testid="next">Next</button></section>';
    const buttons = document.querySelectorAll('button');
    send('click', buttons[0]);
    send('click', buttons[1]);
    const events = ipc.sendToHost.mock.calls.filter(
      call => call[0] === BrowserRecordingChannel.Event,
    );
    expect(events[0][1].target.selector).not.toBe(events[1][1].target.selector);
    expect(document.querySelector(events[1][1].target.selector)).toBe(buttons[1]);
    expect(events[1][1].target.html).toBe('<button data-testid="next">Next</button>');
  });
  it('prefers the input name over a rotating search placeholder', () => {
    document.body.innerHTML = '<input name="q" placeholder="Trending news">';
    send('click', document.querySelector('input')!);
    const event = ipc.sendToHost.mock.calls.find(
      call => call[0] === BrowserRecordingChannel.Event,
    )![1];
    expect(event.target.name).toBe('q');
    expect(event.target.html).toContain('placeholder="Trending news"');
  });
  it('does not invalidate screenshots for ordinary page mutations', async () => {
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'before');
    const before = ipc.sendToHost.mock.calls.slice(-1)[0][1].revision;
    document.body.append(document.createElement('video'));
    await Promise.resolve();
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'after');
    expect(ipc.sendToHost.mock.calls.slice(-1)[0][1]).toMatchObject({
      safe: true,
      revision: before,
    });
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    await Promise.resolve();
    ipc.callbacks.get(BrowserRecordingChannel.Capture)!(null, 'password');
    expect(ipc.sendToHost.mock.calls.slice(-1)[0][1].revision).toBeGreaterThan(before);
  });
});
