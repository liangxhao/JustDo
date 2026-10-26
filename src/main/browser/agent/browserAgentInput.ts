type InputModifier = 'shift' | 'control' | 'alt' | 'meta';
type MouseButton = 'left' | 'middle' | 'right';
type Point = { x: number; y: number };
type InputDebugger = Pick<Electron.Debugger, 'sendCommand'>;
type KeyDescription = { key: string; code: string; keyCode: number; text?: string };

const modifierMask = (modifiers: InputModifier[]): number =>
  modifiers.reduce(
    (mask, modifier) => mask | { alt: 1, control: 2, meta: 4, shift: 8 }[modifier],
    0,
  );

const NAMED_KEYS: Record<string, KeyDescription> = {
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  numlock: { key: 'NumLock', code: 'NumLock', keyCode: 144 },
  scrolllock: { key: 'ScrollLock', code: 'ScrollLock', keyCode: 145 },
  pause: { key: 'Pause', code: 'Pause', keyCode: 19 },
  printscreen: { key: 'PrintScreen', code: 'PrintScreen', keyCode: 44 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
};

const PUNCTUATION_KEYS: Array<[string, string, string, number]> = [
  [';', ':', 'Semicolon', 186],
  ['=', '+', 'Equal', 187],
  [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
  ['[', '{', 'BracketLeft', 219],
  ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221],
  ["'", '"', 'Quote', 222],
];

const describeKey = (rawKey: string, modifiers: InputModifier[]): KeyDescription => {
  const named = NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return named;
  const functionKey = /^F([1-9]|1\d|2[0-4])$/i.exec(rawKey);
  if (functionKey) {
    const key = `F${Number(functionKey[1])}`;
    return { key, code: key, keyCode: 111 + Number(functionKey[1]) };
  }
  const letter = /^(?:Key)?([a-z])$/i.exec(rawKey);
  if (letter) {
    const upper = letter[1]!.toUpperCase();
    const key = modifiers.includes('shift') || rawKey === upper ? upper : upper.toLowerCase();
    return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  }
  const digit = /^(?:Digit)?([0-9])$/.exec(rawKey);
  const shiftedDigits = ')!@#$%^&*(';
  if (digit) {
    const key = modifiers.includes('shift') ? shiftedDigits[Number(digit[1])]! : digit[1]!;
    return { key, code: `Digit${digit[1]}`, keyCode: digit[1]!.charCodeAt(0), text: key };
  }
  const shiftedDigitIndex = shiftedDigits.indexOf(rawKey);
  if (rawKey.length === 1 && shiftedDigitIndex >= 0) {
    return {
      key: rawKey,
      code: `Digit${shiftedDigitIndex}`,
      keyCode: String(shiftedDigitIndex).charCodeAt(0),
      text: rawKey,
    };
  }
  const punctuation = PUNCTUATION_KEYS.find(([plain, shifted]) =>
    [plain, shifted].includes(rawKey),
  );
  if (punctuation) {
    const [, shifted, code, keyCode] = punctuation;
    const key = modifiers.includes('shift') ? shifted : rawKey;
    return { key, code, keyCode, text: key };
  }
  if (rawKey === ' ') return NAMED_KEYS.space!;
  if ([...rawKey].length === 1) {
    return { key: rawKey, code: '', keyCode: 0, text: rawKey };
  }
  throw new Error(`Unsupported background browser key: ${rawKey}`);
};

/** Sends only to the original guest target; it never focuses an OS window. */
export class BrowserAgentCdpInput {
  constructor(
    private readonly guestDebugger: InputDebugger,
    private readonly assertActive: () => void,
    private readonly isDestroyed: () => boolean,
  ) {}

  private async send(method: string, parameters: Record<string, unknown>): Promise<void> {
    this.assertActive();
    await this.guestDebugger.sendCommand(method, parameters);
    this.assertActive();
  }

  private async withRelease(
    work: () => Promise<void>,
    method: string,
    parameters: () => Record<string, unknown>,
  ): Promise<void> {
    this.assertActive();
    let failure: { error: unknown } | undefined;
    try {
      await work();
    } catch (error) {
      failure = { error };
    } finally {
      // Cancellation prevents new input, but must release an already attempted press.
      // A rejected press can have reached Chromium, so it also receives a release.
      if (!this.isDestroyed()) {
        try {
          await this.guestDebugger.sendCommand(method, parameters());
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    if (failure) throw failure.error;
    this.assertActive();
  }

  async move(point: Point, modifiers: InputModifier[] = []): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
      modifiers: modifierMask(modifiers),
    });
  }

  async click(
    point: Point,
    button: MouseButton,
    clickCount: number,
    modifiers: InputModifier[],
    hold: () => Promise<void>,
  ): Promise<void> {
    const parameters = {
      x: point.x,
      y: point.y,
      button,
      clickCount,
      modifiers: modifierMask(modifiers),
    };
    await this.withRelease(
      async () => {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...parameters,
          buttons: { left: 1, right: 2, middle: 4 }[button],
        });
        await hold();
        this.assertActive();
      },
      'Input.dispatchMouseEvent',
      () => ({ type: 'mouseReleased', ...parameters, buttons: 0 }),
    );
  }

  async press(key: string, modifiers: InputModifier[], hold: () => Promise<void>): Promise<void> {
    const description = describeKey(key, modifiers);
    const parameters = {
      key: description.key,
      code: description.code,
      windowsVirtualKeyCode: description.keyCode,
      modifiers: modifierMask(modifiers),
    };
    const text = modifiers.some(modifier => ['control', 'alt', 'meta'].includes(modifier))
      ? ''
      : (description.text ?? '');
    await this.withRelease(
      async () => {
        await this.send('Input.dispatchKeyEvent', {
          type: text ? 'keyDown' : 'rawKeyDown',
          ...parameters,
          text,
          unmodifiedText: text,
        });
        await hold();
        this.assertActive();
      },
      'Input.dispatchKeyEvent',
      () => ({ type: 'keyUp', ...parameters }),
    );
  }

  async drag(
    start: Point,
    end: Point,
    wait: (milliseconds: number) => Promise<void>,
  ): Promise<void> {
    await this.move(start);
    let lastPoint = start;
    await this.withRelease(
      async () => {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...start,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await wait(50);
        for (let step = 1; step <= 10; step += 1) {
          this.assertActive();
          const progress = step / 10;
          lastPoint = {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
          };
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            ...lastPoint,
            button: 'left',
            buttons: 1,
          });
          await wait(16);
        }
      },
      'Input.dispatchMouseEvent',
      () => ({ type: 'mouseReleased', ...lastPoint, button: 'left', buttons: 0, clickCount: 1 }),
    );
  }
}
