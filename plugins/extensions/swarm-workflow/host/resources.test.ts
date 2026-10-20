import type { AppMainHost } from '@app-plugin/sdk/main';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

import type { Flow } from '../contracts/flow';
import { FlowStore } from '../data/store';
import { workflowResources } from './resources';

test('requires exact node cleanup before allowing deletion and never deletes borrowed sources', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workflow-resources-'));
  const database = new FlowStore(directory);
  const flow: Flow = {
    id: 'completed', requestId: 'request', parentKey: 'agent:main:justdo:source',
    parentId: 'native-source', agentId: 'main', agents: [], cwd: directory,
    permissionMode: 'workspace', mode: 'auto', goal: 'Work', revision: 3,
    createdAt: 1, updatedAt: 1, status: 'completed',
    nodes: [{
      id: 'work', title: 'Work', task: 'Work', deps: [], kind: 'work', access: 'write',
      status: 'done', sessionKey: 'agent:main:subagent:worker', agentId: 'main',
      agentName: 'Main', runId: 'exact-run', cleanupSettled: false,
    }],
  };
  database.insert(flow);
  const getSessionRuntimeStatus = vi.fn().mockResolvedValue({ known: true, running: false });
  const deleteSession = vi.fn();
  const resources = workflowResources({
    getNativeStateDirectory: () => directory,
    getSessions: () => ({
      getSessionByNativeKey: (key: string) => key === flow.parentKey ? { id: 'source' } : null,
      deleteSession,
    }),
    getExecution: () => ({ getSessionRuntimeStatus }),
  } as unknown as AppMainHost);
  try {
    expect(resources.protectedResources!()).toEqual(['source']);
    await expect(resources.prepareDelete(['source'])).rejects.toThrow('swarmWorkflowDeleteUnresolved');
    database.put({ ...flow, nodes: flow.nodes.map(node => ({ ...node, cleanupSettled: true })) });
    await expect(resources.prepareDelete(['source'])).resolves.toBeUndefined();
    expect(getSessionRuntimeStatus).toHaveBeenLastCalledWith('source', {
      includeSubagents: true, forceRefresh: true, fullScan: true,
    });
    expect(resources.isManaged('source')).toBe(false);
    await expect(resources.deleteManaged('source')).resolves.toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
    expect(database.get(flow.id)).toMatchObject({ id: flow.id, parentKey: flow.parentKey });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
