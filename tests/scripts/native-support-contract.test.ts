import { afterEach, expect, it, vi } from 'vitest';

const acorn = require('acorn');
const { verifyNativeSupportBindings } = require('../../scripts/openclaw/native-support-contract.cjs');

afterEach(() => vi.restoreAllMocks());

it('shares a complete parse across helper queries while checking every expected body', () => {
  const parse = vi.spyOn(acorn.Parser, 'parse');
  const source = 'function first(input) { return input + 1; } function second(input) { return input + 2; }';
  const first = 'export function first(input) { return input + 1; }';
  const second = 'export function second(input) { return input + 2; }';

  verifyNativeSupportBindings(source, first);
  verifyNativeSupportBindings(source, second);
  expect(() => verifyNativeSupportBindings(source, first.replace('+ 1', '+ 3'))).toThrow(/partial or stale/);
  verifyNativeSupportBindings(source, first);

  expect(parse).toHaveBeenCalledTimes(1);
  expect(() => verifyNativeSupportBindings(source.replace('+ 1', '+ 3'), first)).toThrow(/partial or stale/);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(() => verifyNativeSupportBindings(source + ' var first;', first)).toThrow(/binding changed/);
  expect(() => verifyNativeSupportBindings(source + ' function broken(', first)).toThrow(/invalid native syntax/);
  verifyNativeSupportBindings(source, first);
});

it('keeps lazy constants and owner checks independent across repeated queries', () => {
  const source = `
    var __esm = factory;
    var LIMIT;
    function helper(input) { return input + LIMIT; }
    var init_policy = __esm({ '/runtime/dist/native-support/policy.mjs'() { LIMIT = 2; } });
    var init_owner = __esm({ '/runtime/dist/owner.mjs'() { init_policy(); } });
    var init_other = __esm({ '/runtime/dist/other.mjs'() { sideEffect(); init_policy(); } });
  `;
  const expected = 'export const LIMIT = 2; export function helper(input) { return input + LIMIT; }';
  const lazy = { module: 'policy.mjs', owner: 'owner.mjs' };
  const parse = vi.spyOn(acorn.Parser, 'parse');

  verifyNativeSupportBindings(source, expected, undefined, lazy);
  expect(() => verifyNativeSupportBindings(source, expected, undefined,
    { ...lazy, owner: 'other.mjs' })).toThrow(/initialization/);
  expect(() => verifyNativeSupportBindings(source, expected, undefined,
    { ...lazy, module: 'missing.mjs' })).toThrow(/initializer/);
  expect(() => verifyNativeSupportBindings(source, expected)).toThrow(/missing static initializer/);
  verifyNativeSupportBindings(source, expected, undefined, lazy);

  expect(parse).toHaveBeenCalledTimes(1);
});

it('rejects malformed matching initializers without rejecting unrelated factories', () => {
  const source = `
    const LIMIT = 2;
    var candidate = factory({ '/runtime/dist/native-support/policy.mjs': () => {} });
  `;
  const expected = 'export const LIMIT = 2;';

  verifyNativeSupportBindings(source, expected, undefined, { module: 'other.mjs', owner: 'owner.mjs' });
  expect(() => verifyNativeSupportBindings(source, expected, undefined,
    { module: 'policy.mjs', owner: 'owner.mjs' })).toThrow(/initializer shape/);
  verifyNativeSupportBindings(source, expected);
});
