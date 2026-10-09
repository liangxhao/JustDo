// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { BrowserInterventionFloat } from './BrowserInterventionFloat';

afterEach(cleanup);

test('drags within the webpage bounds and leaves description editing independent', () => {
  const { container } = render(
    <div>
      <BrowserInterventionFloat>
        <textarea aria-label="Description" />
      </BrowserInterventionFloat>
    </div>,
  );
  const panel = screen.getByTestId('browser-intervention-float');
  const host = container.firstElementChild!;
  Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  Object.defineProperties(panel, { offsetWidth: { value: 320 }, offsetHeight: { value: 160 } });
  const header = screen.getByRole('button');
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    fireEvent(header, event);
  };
  pointer('pointerdown', 20, 20);
  pointer('pointermove', 120, 80);
  expect(panel.style.left).toBe('112px');
  expect(panel.style.top).toBe('72px');
  pointer('pointermove', 2000, 2000);
  expect(panel.style.left).toBe('472px');
  expect(panel.style.top).toBe('432px');
  pointer('pointerup', 2000, 2000);
  pointer('pointermove', 30, 30);
  expect(panel.style.left).toBe('472px');
  fireEvent.keyDown(header, { key: 'ArrowLeft' });
  expect(panel.style.left).toBe('456px');
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'Signed in\nVerified account' },
  });
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Signed in\nVerified account');
  expect(panel.style.left).toBe('456px');
});
