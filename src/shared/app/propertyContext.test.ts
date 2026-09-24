import { expect, test } from 'vitest';

import { createPropertyContext } from './propertyContext';

test('reads current dependencies and writes through after the owner replaces its state', () => {
  let state = { sessionId: 'first' };
  const context = createPropertyContext<{ state: typeof state }>({
    state: {
      get: () => state,
      set: value => {
        state = value;
      },
    },
  });

  state = { sessionId: 'second' };
  expect(context.state).toBe(state);
  context.state = { sessionId: 'third' };
  expect(state.sessionId).toBe('third');
});

test('exposes only declared dependencies and resolves replacement callbacks at call time', () => {
  let read = () => 'before reconnect';
  const context = createPropertyContext<{ read: () => string }>({
    read: { get: () => read },
  });

  read = () => 'after reconnect';
  expect(context.read()).toBe('after reconnect');
  expect(Object.keys(context)).toEqual(['read']);
});
