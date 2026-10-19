import { expect, it } from 'vitest';

import type { FlowNode } from '../contracts/flow';
import { continuationInstructions, validateIntervention } from '../execution/intervention';

function node(): FlowNode {
  return {
    id: 'work', title: 'Inspect', task: 'Original task', deps: [], kind: 'work',
    access: 'read', status: 'queued', sessionKey: 'native', agentId: 'main', agentName: 'Main',
    continuation: true,
    interventions: [
      { id: 'old-note', action: 'note', text: 'Already consumed', createdAt: 1 },
      { id: 'old-input', action: 'continue', text: 'Previous continuation', createdAt: 2 },
      { id: 'new-note', action: 'note', text: 'New saved evidence', createdAt: 3 },
      { id: 'current', action: 'continue', text: 'Current input', createdAt: 4 },
    ],
    dispatch: { message: 'Current input', createdAt: 4, interventionCount: 4 },
  };
}

it('preserves saved notes across native runs without replaying prior user messages', () => {
  const current = node();
  const context = continuationInstructions(current)!;
  expect(context).toContain('New saved evidence');
  expect(context).toContain('Already consumed');
  for (const text of ['Original task', 'Previous continuation', 'Current input'])
    expect(context).not.toContain(text);
  expect(context).toContain('read-only');
  expect(context).toContain('swarm_workflow_complete');
  expect(context).toContain('Prior submissions do not complete this new run');
  current.attempts = [{ attempt: 2, sessionKey: 'native', status: 'failed' }];
  expect(continuationInstructions(current)).toContain('Already consumed');
  expect(continuationInstructions(current)).toContain('New saved evidence');
});

it('retains the dispatched notes during submission repair and defers newer notes', () => {
  const current = node();
  current.continuation = false;
  expect(continuationInstructions(current)).toBeUndefined();
  current.continuation = true;
  current.interventions!.push({ id: 'later', action: 'note', text: 'For the next task attempt', createdAt: 5 });
  current.submissionRepair = { runId: 'repair', passes: 1, instruction: 'Submit only', priorRuns: [] };
  const context = continuationInstructions(current)!;
  expect(context).toContain('Already consumed');
  expect(context).toContain('New saved evidence');
  expect(context).not.toContain('For the next task attempt');
  expect(context).not.toContain('Resolve the blocker');
  expect(context).not.toContain('swarm_workflow_complete');
  delete current.dispatch;
  delete current.submissionRepair;
  expect(continuationInstructions(current)).toContain('For the next task attempt');
});

it('preserves literal intervention text while rejecting whitespace-only input', () => {
  const text = '  新证据\n\n    保留缩进  ';
  expect(validateIntervention({ id: 'input', action: 'continue', text }).text).toBe(text);
  expect(() => validateIntervention({ id: 'blank', action: 'continue', text: ' \n ' })).toThrow('Invalid');
});
