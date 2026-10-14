import { expect, it } from 'vitest';

import { resultPage } from '../../../openclaw-extensions/swarm-workflow/batch/result-page';
import {
  RESULT_PAGE_TRANSPORT_BUDGET,
  RESULT_TRANSPORT_BYTES,
  resultTransportCost,
} from '../../../openclaw-extensions/swarm-workflow/contracts/batch';
import type { Flow, FlowNode } from '../../../openclaw-extensions/swarm-workflow/contracts/flow';
const result = JSON.stringify({
  summary: 'Detailed findings',
  evidence: Array(16).fill('真实产物😀'.repeat(400)),
});
const source = {
  id: 'work',
  kind: 'work',
  status: 'done',
  result,
  runId: 'exact-run',
  attempt: 1,
} as FlowNode;
const reader = { id: 'verify', kind: 'verify', deps: ['work'] } as FlowNode;
const flow = { id: 'flow', nodes: [source, reader] } as Flow;
it('returns bounded fragments that reconstruct the full accepted result', () => {
  let cursor: string | undefined;
  let joined = '';
  let pages = 0;
  do {
    const page = resultPage(flow, reader, 'work', cursor);
    joined += page.text;
    cursor = page.cursor;
    pages++;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(32768);
    expect(resultTransportCost(page)).toBeLessThanOrEqual(RESULT_TRANSPORT_BYTES);
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  } while (cursor);
  expect(pages).toBeGreaterThan(10);
  expect(joined).toBe(result);
});
it('keeps native wrappers readable for rare CJK and escaped control characters', () => {
  for (const result of [
    '\u9fa6'.repeat(7000),
    '\u{20000}'.repeat(7000),
    '\u0000\n\t'.repeat(3000),
  ]) {
    const current = { ...flow, nodes: [{ ...source, result }, reader] };
    let cursor: string | undefined;
    let joined = '';
    do {
      const page = resultPage(current, reader, 'work', cursor);
      joined += page.text;
      cursor = page.cursor;
      expect(resultTransportCost(page)).toBeLessThanOrEqual(RESULT_TRANSPORT_BYTES);
    } while (cursor);
    expect(joined).toBe(result);
  }
});
it('reconstructs all results under the plugin page policy without native hook budget metadata', () => {
  let cursor: string | undefined;
  let joined = '';
  do {
    const page = resultPage(flow, reader, 'work', cursor, RESULT_PAGE_TRANSPORT_BUDGET);
    joined += page.text;
    cursor = page.cursor;
    expect(resultTransportCost(page)).toBeLessThanOrEqual(RESULT_PAGE_TRANSPORT_BUDGET);
    expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  } while (cursor);
  expect(joined).toBe(result);
});
it('rejects an unreadable fragment instead of raising a valid sub-minimum native cap', () => {
  for (const budget of [1, 50, 500]) {
    expect(() => resultPage(flow, reader, 'work', undefined, budget)).toThrow('transport budget');
  }
});
it('rejects when real workflow identities alone exceed a small reader budget', () => {
  const current = {
    ...flow,
    id: '12345678-1234-1234-1234-123456789abc',
    nodes: [{ ...source, runId: '12345678-1234-1234-1234-123456789def' }, reader],
  };
  expect(() => resultPage(current, reader, 'work', undefined, 1000)).toThrow('transport budget');
});
it('binds cursors to the exact accepted attempt and dependency scope', () => {
  const cursor = resultPage(flow, reader, 'work').cursor;
  expect(() => resultPage({ ...flow, id: 'other' }, reader, 'work', cursor)).toThrow('cursor');
  expect(() =>
    resultPage({ ...flow, nodes: [{ ...source, attempt: 2 }, reader] }, reader, 'work', cursor),
  ).toThrow('cursor');
  expect(() => resultPage(flow, { ...reader, kind: 'work', deps: [] }, 'work')).toThrow(
    'dependency',
  );
  expect(() =>
    resultPage({ ...flow, nodes: [{ ...source, status: 'running' }, reader] }, reader, 'work'),
  ).toThrow('dependency');
});
