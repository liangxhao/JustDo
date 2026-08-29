// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import BottomRightStatusStack from './BottomRightStatusStack';

describe('BottomRightStatusStack', () => {
  afterEach(cleanup);

  it('stacks simultaneous status notices in the shared bottom-right position', () => {
    const { container } = render(
      React.createElement(
        BottomRightStatusStack,
        null,
        React.createElement('div', null, 'engine status'),
        React.createElement('div', null, 'update status'),
      ),
    );

    const stack = container.firstElementChild;
    expect(stack?.classList.contains('fixed')).toBe(true);
    expect(stack?.classList.contains('bottom-4')).toBe(true);
    expect(stack?.classList.contains('right-4')).toBe(true);
    expect(stack?.classList.contains('flex-col')).toBe(true);
    expect(stack?.classList.contains('gap-2')).toBe(true);
    expect(stack?.children).toHaveLength(2);
  });
});
