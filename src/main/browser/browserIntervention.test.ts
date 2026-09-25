import { expect, test } from 'vitest';

import { BrowserIntervention } from './browserIntervention';

test('manual admission waits for actual work to drain after abort and confirmed task stop', () => {
  const gate = new BrowserIntervention();
  const work = gate.track('session');
  const other = gate.track('other');
  const hold = gate.begin('session', 'page');
  expect(hold.stopConfirmed).toBe(false);
  expect(work.signal.aborted).toBe(true);
  expect(other.signal.aborted).toBe(false);
  expect(() => gate.track('session')).toThrow('manually operating');
  gate.change('session', hold.token, 'confirmStop');
  expect(gate.read('session')?.stopConfirmed).toBe(true);
  expect(gate.read('session')?.phase).toBe('stopping');
  expect(() => gate.change('session', hold.token, 'resume')).toThrow('busy');
  work.finish();
  expect(gate.read('session')?.phase).toBe('manual');
  expect(gate.change('session', hold.token, 'resume')?.phase).toBe('resuming');
  expect(() => gate.change('session', hold.token, 'resume')).toThrow('busy');
  const resumed = gate.track('session');
  expect(resumed.signal.aborted).toBe(false);
  gate.change('session', hold.token, 'complete');
  expect(gate.read('session')).toBeNull();
  resumed.finish();
  other.finish();
});

test('unknown continuation is never replayed and a fresh stop fences old acknowledgements', () => {
  const gate = new BrowserIntervention();
  const first = gate.begin('session', 'page');
  expect(gate.read('session')?.phase).toBe('stopping');
  gate.change('session', first.token, 'confirmStop');
  gate.change('session', first.token, 'resume');
  expect(gate.read('session')?.phase).toBe('resuming');
  const second = gate.begin('session', 'new-page');
  expect(second.token).not.toBe(first.token);
  expect(() => gate.change('session', first.token, 'complete')).toThrow('stale');
  expect(gate.read('session')?.phase).toBe('stopping');
});

test('retrying a manual hold requires a fresh task-stop confirmation', () => {
  const gate = new BrowserIntervention();
  const first = gate.begin('session', 'page');
  gate.change('session', first.token, 'confirmStop');
  expect(gate.read('session')?.phase).toBe('manual');
  gate.begin('session', 'new-page');
  expect(() => gate.change('session', first.token, 'confirmStop')).toThrow('stale');
  expect(gate.read('session')?.phase).toBe('stopping');
});
