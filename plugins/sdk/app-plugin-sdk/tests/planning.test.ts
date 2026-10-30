import { expect, test, vi } from 'vitest';

import {
  describePlanningConstraint,
  hasUnrestrictedPlanningSnapshot,
  nativePlanningConstraint,
  PlanningConstraint,
  readPlanningSnapshot,
} from '../planning';

const identity = { sessionKey: 'agent:main:source', nativeSessionId: 'native', lifecycleRevision: 'r1' };
const selector = { ...identity, pluginId: 'plan-mode', namespace: 'state' };

test('planning restrictions include pending reviews and malformed persisted namespaces', () => {
  const entry = (state: unknown) => ({ pluginExtensions: { 'plan-mode': { state } } });
  expect(nativePlanningConstraint({})).toBe(PlanningConstraint.Unrestricted);
  expect(nativePlanningConstraint(entry({ enabled: false }))).toBe(PlanningConstraint.Unrestricted);
  expect(nativePlanningConstraint(entry({ enabled: true }))).toBe(PlanningConstraint.Planning);
  expect(nativePlanningConstraint(entry({ enabled: false, awaitingReview: { requestId: 'review' } })))
    .toBe(PlanningConstraint.Review);
  for (const value of [undefined, null, entry(null), entry({}), entry(undefined), { pluginExtensions: [] },
    { pluginExtensions: { 'plan-mode': undefined } }])
    expect(nativePlanningConstraint(value)).toBe(PlanningConstraint.Unknown);
});

test('a successful planning read must match the exact native incarnation', () => {
  const snapshot = { ...identity, planning: PlanningConstraint.Unrestricted };
  expect(hasUnrestrictedPlanningSnapshot(snapshot, identity)).toBe(true);
  for (const drift of [{ nativeSessionId: 'replacement' }, { lifecycleRevision: 'r2' },
    { sessionKey: 'agent:main:other' }, { planning: PlanningConstraint.Unknown }])
    expect(hasUnrestrictedPlanningSnapshot({ ...snapshot, ...drift }, identity)).toBe(false);
});

test('confirmed raw namespace absence is required even when the display projection omits Plan', async () => {
  expect(describePlanningConstraint([])).toBe(PlanningConstraint.Unrestricted);
  const read = vi.fn(async () => ({ ...selector, present: true,
    value: { enabled: false, awaitingReview: { requestId: 'pending' } } }));
  expect((await readPlanningSnapshot(read, identity)).planning).toBe(PlanningConstraint.Review);
  expect(read).toHaveBeenCalledExactlyOnceWith(selector);
  expect((await readPlanningSnapshot(async () => ({ ...selector, present: false }), identity)).planning)
    .toBe(PlanningConstraint.Unrestricted);
});

test('malformed or mismatched namespace responses never establish Plan absence', async () => {
  for (const result of [undefined, {}, { ...selector, present: false, value: undefined },
    { ...selector, present: true }, { ...selector, present: true, value: {} },
    { ...selector, present: false, nativeSessionId: 'replacement' },
    { ...selector, present: false, lifecycleRevision: 'r2' },
    { ...selector, present: false, pluginId: 'other' }])
    expect((await readPlanningSnapshot(async () => result, identity)).planning)
      .toBe(PlanningConstraint.Unknown);
  await expect(readPlanningSnapshot(async () => { throw new Error('unavailable'); }, identity))
    .rejects.toThrow('unavailable');
});
