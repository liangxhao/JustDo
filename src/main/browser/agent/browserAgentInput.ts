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

const describeKey = (
  rawKey: string,
  modifiers: InputModifier[],
  native = false,
): KeyDescription => {
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
  // The native API validates its own Accelerator names, including platform
  // keys outside CDP's mapping. Keep the original sidebar acceptance range.
  if (native) return { key: rawKey, code: '', keyCode: 0 };
  throw new Error(`Unsupported background browser key: ${rawKey}`);
};

const nativeAcceleratorKey = (key: string): string => {
  const arrow = /^Arrow(Left|Right|Up|Down)$/i.exec(key);
  if (arrow) return arrow[1]![0]!.toUpperCase() + arrow[1]!.slice(1).toLowerCase();
  const letter = /^Key([a-z])$/i.exec(key);
  if (letter) return letter[1]!.toUpperCase();
  const digit = /^Digit([0-9])$/.exec(key);
  return digit ? digit[1]! : key;
};

type MousePacket = {
  phase: 'move' | 'down' | 'up';
  point: Point;
  button: MouseButton | 'none';
  buttons: number;
  modifiers: InputModifier[];
  clickCount?: number;
};
type KeyPacket = {
  phase: 'down' | 'up';
  key: string;
  description: KeyDescription;
  modifiers: InputModifier[];
  text: string;
};
interface BrowserAgentInputTarget {
  native?: boolean;
  mouse(event: MousePacket): Promise<void>;
  key(event: KeyPacket): Promise<void>;
}

/** Input sequencing and cancellation belong to the original target. */
class BrowserAgentInputSequence {
  constructor(
    private readonly target: BrowserAgentInputTarget,
    private readonly assertActive: () => void,
    private readonly isDestroyed: () => boolean,
  ) {}

  private async send(operation: () => Promise<void>): Promise<void> {
    this.assertActive();
    await operation();
    this.assertActive();
  }

  private async withRelease(
    work: () => Promise<void>,
    release: () => Promise<void>,
  ): Promise<void> {
    this.assertActive();
    let failure: { error: unknown } | undefined;
    try {
      await work();
    } catch (error) {
      failure = { error };
    } finally {
      // A failed press may already have reached Chromium. Cancellation blocks
      // new input while still releasing that press on its original target.
      if (!this.isDestroyed()) {
        try {
          await release();
        } catch (error) {
          failure ??= { error };
        }
      }
    }
    if (failure) throw failure.error;
    this.assertActive();
  }

  async move(point: Point, modifiers: InputModifier[] = []): Promise<void> {
    await this.send(() =>
      this.target.mouse({ phase: 'move', point, button: 'none', buttons: 0, modifiers }),
    );
  }

  async click(
    point: Point,
    button: MouseButton,
    clickCount: number,
    modifiers: InputModifier[],
    hold: () => Promise<void>,
  ): Promise<void> {
    const parameters = { point, button, clickCount, modifiers };
    await this.withRelease(
      async () => {
        await this.send(() =>
          this.target.mouse({
            phase: 'down',
            ...parameters,
            buttons: { left: 1, right: 2, middle: 4 }[button],
          }),
        );
        await hold();
        this.assertActive();
      },
      () => this.target.mouse({ phase: 'up', ...parameters, buttons: 0 }),
    );
  }

  async press(key: string, modifiers: InputModifier[], hold: () => Promise<void>): Promise<void> {
    const description = describeKey(key, modifiers, this.target.native);
    const text = modifiers.some(modifier => ['control', 'alt', 'meta'].includes(modifier))
      ? ''
      : (description.text ?? '');
    const parameters = { key, description, modifiers, text };
    await this.withRelease(
      async () => {
        await this.send(() => this.target.key({ phase: 'down', ...parameters }));
        await hold();
        this.assertActive();
      },
      () => this.target.key({ phase: 'up', ...parameters }),
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
        await this.send(() =>
          this.target.mouse({
            phase: 'down',
            point: start,
            button: 'left',
            buttons: 1,
            clickCount: 1,
            modifiers: [],
          }),
        );
        await wait(50);
        for (let step = 1; step <= 10; step += 1) {
          this.assertActive();
          const progress = step / 10;
          lastPoint = {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
          };
          await this.send(() =>
            this.target.mouse({
              phase: 'move',
              point: lastPoint,
              button: 'left',
              buttons: 1,
              modifiers: [],
            }),
          );
          await wait(16);
        }
      },
      () =>
        this.target.mouse({
          phase: 'up',
          point: lastPoint,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers: [],
        }),
    );
  }
}

/** CDP input for the independent, offscreen background-window target. */
export class BrowserAgentCdpInput extends BrowserAgentInputSequence {
  constructor(guestDebugger: InputDebugger, assertActive: () => void, isDestroyed: () => boolean) {
    super(
      {
        mouse: async event => {
          await guestDebugger.sendCommand('Input.dispatchMouseEvent', {
            type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[event.phase],
            x: event.point.x,
            y: event.point.y,
            button: event.button,
            buttons: event.buttons,
            modifiers: modifierMask(event.modifiers),
            ...(event.clickCount !== undefined ? { clickCount: event.clickCount } : {}),
          });
        },
        key: async event => {
          const { description, text } = event;
          await guestDebugger.sendCommand('Input.dispatchKeyEvent', {
            type: event.phase === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
            key: description.key,
            code: description.code,
            windowsVirtualKeyCode: description.keyCode,
            modifiers: modifierMask(event.modifiers),
            ...(event.phase === 'down' ? { text, unmodifiedText: text } : {}),
          });
        },
      },
      assertActive,
      isDestroyed,
    );
  }
}

/** Direct sidebar guest input avoids CDP InputInjector's implicit widget focus. */
export class BrowserAgentNativeInput extends BrowserAgentInputSequence {
  constructor(
    guest: Pick<Electron.WebContents, 'sendInputEvent' | 'isDestroyed'>,
    assertActive: () => void,
  ) {
    super(
      {
        native: true,
        mouse: async event => {
          const buttons: NonNullable<Electron.MouseInputEvent['modifiers']> = [...event.modifiers];
          if (event.buttons & 1) buttons.push('leftbuttondown');
          if (event.buttons & 2) buttons.push('rightbuttondown');
          if (event.buttons & 4) buttons.push('middlebuttondown');
          guest.sendInputEvent({
            type: { move: 'mouseMove', down: 'mouseDown', up: 'mouseUp' }[
              event.phase
            ] as Electron.MouseInputEvent['type'],
            x: Math.round(event.point.x),
            y: Math.round(event.point.y),
            ...(event.button !== 'none' ? { button: event.button } : {}),
            modifiers: buttons,
            ...(event.clickCount !== undefined ? { clickCount: event.clickCount } : {}),
          });
        },
        key: async event => {
          const keyCode = nativeAcceleratorKey(event.key);
          guest.sendInputEvent({
            type: event.phase === 'up' ? 'keyUp' : 'keyDown',
            keyCode,
            modifiers: event.modifiers,
          });
          if (event.phase === 'down' && event.text) {
            assertActive();
            guest.sendInputEvent({ type: 'char', keyCode: event.text, modifiers: event.modifiers });
          }
        },
      },
      assertActive,
      () => guest.isDestroyed(),
    );
  }
}
