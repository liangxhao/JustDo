import path from 'node:path';
import { expect, it } from 'vitest';
import { itemWorkspace } from '../../../openclaw-extensions/swarm-flow/batch-snapshot';
import type { Flow, FlowNode } from '../../../openclaw-extensions/swarm-flow/contract';
import { TASK_WORKSPACE_DIRECTORY } from '../../../src/shared/cowork/taskWorkspace';

function fixture() {
  const cwd = path.resolve('project');
  const stage = { id: 'task-1', kind: 'batch' } as FlowNode;
  const flow = { id: 'flow-1', cwd, nodes: [stage] } as Flow;
  const item = { id: 'item-1', attempt: 1, batchItem: { stageId: stage.id } } as FlowNode;
  return { flow, item, stage, cwd };
}

it('places Swarm attempts under the shared task root using its standalone directory contract', () => {
  const { flow, item, cwd } = fixture();
  const workspace = itemWorkspace(flow, item);
  expect(workspace).toBe(path.join(cwd, '.agent-tasks', 'swarm', 'flow-1', 'task-1', 'item-1', 'attempt-1'));
  expect(path.relative(cwd, workspace).split(path.sep)[0]).toBe(TASK_WORKSPACE_DIRECTORY);
});

it('keeps retry attempts in the dedicated Swarm directory', () => {
  const f = fixture();
  const directory = path.join(f.cwd, '.agent-tasks', 'swarm', f.flow.id, f.stage.id);
  expect(itemWorkspace(f.flow, f.item)).toBe(path.join(directory, f.item.id, 'attempt-1'));
  f.item.attempt = 2;
  expect(itemWorkspace(f.flow, f.item)).toBe(path.join(directory, f.item.id, 'attempt-2'));
});

it.each(['unrelated-root', 'other-flow', 'other-stage'])('does not redirect an item using a manifest from %s', kind => {
  const f = fixture();
  f.stage.batchInput = { version: 'v1', manifestPath: path.join(f.cwd, kind === 'unrelated-root' ? 'external-output' : '.agent-tasks', 'swarm', kind === 'other-flow' ? 'flow-2' : f.flow.id, kind === 'other-stage' ? 'task-2' : f.stage.id, 'snapshot-original', 'manifest.json') };
  expect(itemWorkspace(f.flow, f.item)).toBe(path.join(f.cwd, '.agent-tasks', 'swarm', f.flow.id, f.stage.id, f.item.id, 'attempt-1'));
});
