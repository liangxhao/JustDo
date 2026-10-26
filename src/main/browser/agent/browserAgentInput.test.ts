import { describe, expect, test, vi } from 'vitest';

import { BrowserAgentCdpInput } from './browserAgentInput';

const createInput = () => {
  let cancelled = false;
  let destroyed = false;
  const sendCommand = vi.fn(async (_method: string, _parameters?: Record<string, unknown>) => {});
  const input = new BrowserAgentCdpInput(
    { sendCommand },
    () => {
      if (cancelled) throw new Error('cancelled');
    },
    () => destroyed,
  );
  return {
    input,
    sendCommand,
    cancel: () => (cancelled = true),
    destroy: () => (destroyed = true),
  };
};

describe('focus independent Chromium input', () => {
  test.each([
    ['Enter', [], { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
    [
      'a',
      ['control'],
      { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: '', modifiers: 2 },
    ],
    ['a', ['shift'], { key: 'A', code: 'KeyA', text: 'A', modifiers: 8 }],
    ['Space', [], { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }],
    ['ArrowLeft', ['alt'], { key: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 }],
    ['F12', [], { key: 'F12', windowsVirtualKeyCode: 123 }],
    ['中', [], { key: '中', text: '中' }],
  ] as const)(
    'sends the Chromium key description for %s with %j',
    async (key, modifiers, expected) => {
      const { input, sendCommand } = createInput();

      await input.press(key, [...modifiers], async () => {});

      expect(sendCommand).toHaveBeenNthCalledWith(
        1,
        'Input.dispatchKeyEvent',
        expect.objectContaining(expected),
      );
      expect(sendCommand).toHaveBeenNthCalledWith(
        2,
        'Input.dispatchKeyEvent',
        expect.objectContaining({ key: expected.key, type: 'keyUp' }),
      );
    },
  );

  test('releases a key when cancellation arrives with the key-down reply', async () => {
    const fixture = createInput();
    fixture.sendCommand.mockImplementationOnce(async () => fixture.cancel());
    const hold = vi.fn(async () => {});

    await expect(fixture.input.press('Enter', [], hold)).rejects.toThrow('cancelled');

    expect(hold).not.toHaveBeenCalled();
    expect(fixture.sendCommand).toHaveBeenCalledTimes(2);
    expect(fixture.sendCommand).toHaveBeenLastCalledWith(
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyUp', code: 'Enter' }),
    );
  });

  test('releases a possibly delivered mouse press after a rejected transport reply', async () => {
    const { input, sendCommand } = createInput();
    sendCommand.mockRejectedValueOnce(new Error('transport lost'));

    await expect(input.click({ x: 20, y: 30 }, 'right', 1, [], async () => {})).rejects.toThrow(
      'transport lost',
    );

    expect(sendCommand).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 20,
      y: 30,
      button: 'right',
      buttons: 0,
      clickCount: 1,
      modifiers: 0,
    });
  });

  test('stops a cancelled drag and releases at its last dispatched point', async () => {
    const fixture = createInput();
    const wait = vi.fn(async milliseconds => {
      if (milliseconds === 16) fixture.cancel();
    });

    await expect(fixture.input.drag({ x: 0, y: 0 }, { x: 100, y: 200 }, wait)).rejects.toThrow(
      'cancelled',
    );

    const commands = fixture.sendCommand.mock.calls.map(([, parameters]) => parameters);
    expect(
      commands.filter(command => command?.buttons === 1 && command.type === 'mouseMoved'),
    ).toEqual([{ type: 'mouseMoved', x: 10, y: 20, button: 'left', buttons: 1 }]);
    expect(commands.at(-1)).toEqual({
      type: 'mouseReleased',
      x: 10,
      y: 20,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  });

  test('does not send input after cancellation or release into a destroyed target', async () => {
    const fixture = createInput();
    fixture.cancel();
    await expect(fixture.input.move({ x: 10, y: 20 })).rejects.toThrow('cancelled');
    expect(fixture.sendCommand).not.toHaveBeenCalled();

    const destroyed = createInput();
    await destroyed.input.click({ x: 10, y: 20 }, 'left', 1, [], async () => destroyed.destroy());
    expect(destroyed.sendCommand).toHaveBeenCalledTimes(1);
  });

  test('surfaces a release failure after an otherwise successful press', async () => {
    const { input, sendCommand } = createInput();
    sendCommand.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('release failed'));

    await expect(input.press('Backspace', [], async () => {})).rejects.toThrow('release failed');
  });

  test('does not spread element metadata into Chromium input parameters', async () => {
    const { input, sendCommand } = createInput();
    const point = { x: 20, y: 30, editable: true, disabled: false };

    await input.move(point);
    await input.click(point, 'middle', 1, ['shift', 'meta'], async () => {});

    expect(sendCommand).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: 20,
      y: 30,
      button: 'none',
      buttons: 0,
      modifiers: 0,
    });
    expect(sendCommand).toHaveBeenNthCalledWith(2, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 20,
      y: 30,
      button: 'middle',
      buttons: 4,
      clickCount: 1,
      modifiers: 12,
    });
  });
});
