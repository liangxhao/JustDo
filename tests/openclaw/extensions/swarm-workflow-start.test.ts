import { expect, it } from 'vitest';
import { lastStartError, startInstructions } from '../../../plugins/extensions/swarm-workflow/prompt/start';

it('prefers prompt launch for clear requests and prepares only to resolve uncertainty under native permissions', () => {
  const instruction = startInstructions('review', 'request:user');
  expect(instruction).toContain('use normally available tools as needed');
  expect(instruction).toContain('prepare a preliminary plan');
  expect(instruction).toContain('sufficiently clear, promptly call swarm_workflow_start');
  expect(instruction).toContain('Only when material uncertainty or missing context');
  expect(instruction).toContain('do not stop after analysis or a plan');
  expect(instruction).not.toContain('Before launching, use');
  expect(instruction).toContain('Existing permissions, approvals and tool restrictions remain in force');
  expect(instruction).toContain('The Swarm Workflow service owns the execution DAG');
  expect(instruction).toContain('current attachments');
  expect(instruction).toContain('self-contained goal');
  expect(instruction).toContain('Do not complete the delegated task yourself');
  expect(instruction).toContain('Preparation tool results do not establish workflow acceptance');
  expect(instruction).toContain('without repeating preparation or side effects');
  expect(instruction).toContain('Never blindly retry an unknown launch result');
  expect(instruction).not.toContain('ONLY a workflow launch turn');
  expect(instruction).not.toContain('The only permitted task action');
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
