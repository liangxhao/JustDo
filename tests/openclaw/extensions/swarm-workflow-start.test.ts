import { expect, it } from 'vitest';
import { lastStartError, startInstructions } from '../../../openclaw-extensions/swarm-workflow/start';

it('gives launch-only instructions and named direct and Code Mode arguments without losing context resolution', () => {
  const instruction = startInstructions('review', 'request:user');
  expect(instruction).toContain('The only permitted task action in this turn is swarm_workflow_start');
  expect(instruction).toContain('The Swarm Workflow service owns task planning, execution and progress tracking');
  expect(instruction).toContain('current attachments');
  expect(instruction).toContain('self-contained goal');
  expect(instruction).toContain('"id":"swarm_workflow_start","args":');
  expect(instruction).toContain('"mode":"review","sourceRequestId":"request:user"');
});

it('reads current native and Code Mode errors, but does not use stale errors or previous turns', () => {
  const error = { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'The requested tool is unavailable' }] };
  expect(lastStartError([error], 'current')).toBe('The requested tool is unavailable');
  expect(lastStartError([error, { role: 'user', content: 'Another request' }], 'current')).toBeUndefined();
  expect(lastStartError([{ ...error, runId: 'previous' }], 'current')).toBeUndefined();
  const nested = { role: 'custom', customType: 'openclaw.nested-tool.v1', details: { runId: 'current', isError: true, result: { content: 'Invalid tool arguments' } } };
  expect(lastStartError([nested], 'current')).toBe('Invalid tool arguments');
  expect(lastStartError([nested], 'different')).toBeUndefined();
  expect(lastStartError([{ ...error, content: 'x'.repeat(3000) }], 'current')?.length).toBe(2000);
});
