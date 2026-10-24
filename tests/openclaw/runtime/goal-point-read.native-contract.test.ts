import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { expect, test } from 'vitest';

const sourceRoot = process.env.OPENCLAW_TEST_UPSTREAM_ROOT ?? process.env.OPENCLAW_SOURCE;
const required = process.env.OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS === '1';
if ((required || sourceRoot) && (!sourceRoot || !fs.existsSync(path.join(sourceRoot, 'src/gateway/server-methods/session-active-runs.ts'))))
  throw new Error('Exact target native active-run source is required.');

function source(relative: string) {
  return ts.createSourceFile(relative, fs.readFileSync(path.join(sourceRoot!, relative), 'utf8'), ts.ScriptTarget.Latest, true);
}

function nativeFunction(tree: ts.SourceFile, name: string, ports: Record<string, unknown>) {
  const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  expect(declarations, `one actual native ${name}`).toHaveLength(1);
  const code = ts.transpileModule(declarations[0].getText(tree).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function(...Object.keys(ports), `${code}\nreturn ${name};`)(...Object.values(ports));
}

// Actual full target function bodies with controlled registry ports, not a Gateway/SQLite test.
test.skipIf(!sourceRoot)('native exact activity exposes complete chat identities and preserves projected-owner uncertainty', () => {
  expect(JSON.parse(fs.readFileSync(path.join(sourceRoot!, 'package.json'), 'utf8')).version).toBe('2026.10.6');
  const tree = source('src/gateway/server-methods/session-active-runs.ts');
  const ownerPorts = {
    resolveChatRunOwnerAgentId: ({ agentId }: { agentId: string }) => agentId,
    chatRunBelongsToAgent: (owner: { agentId: string }, agentId: string) => owner.agentId === agentId,
  };
  const match = nativeFunction(tree, 'isTrackedActiveSessionRunForKey', ownerPorts);
  let projected: string | undefined;
  const read = nativeFunction(tree, 'resolveVisibleActiveSessionRunState', {
    ...ownerPorts,
    isTrackedActiveSessionRunForKey: match,
    getLatestLiveSubagentRunByChildSessionKey: () => null,
    isSubagentRunLive: () => false, isSubagentRunQueued: () => false,
    isAgentRunWaitingForCapacity: () => false,
    resolveProjectedAgentRunProgressState: () => projected,
    resolveEmbeddedAgentSessionProgressState: () => undefined,
  });
  const key = 'agent:main:synthetic';
  const params = { context: {}, requestedKey: key, canonicalKey: key, agentId: 'main', sessionId: 'native-1',
    trackedActiveRuns: [{ runId: 'exact-run', sessionKey: key, sessionId: 'native-1', agentId: 'main' }] };
  expect(read(params)).toEqual({ active: true, runIds: ['exact-run'] });
  expect(read({ ...params, trackedActiveRuns: [] })).toEqual({ active: false, runIds: [] });
  expect(read({ ...params, agentId: 'other' })).toEqual({ active: false, runIds: [] });
  for (const state of ['running', 'queued']) {
    projected = state;
    const row = read({ ...params, trackedActiveRuns: [] });
    expect(row.active).toBe(true);
    expect(row).not.toHaveProperty('runIds');
    if (state === 'queued') expect(row.status).toBe('queued');
  }
});

test.skipIf(!sourceRoot)('native describe wires the same active-owner projector and exact identity set into its row', () => {
  const tree = source('src/gateway/server-methods/sessions-read-by-key.ts');
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(calls.some(call => call.expression.getText(tree) === 'prepareProjectedSessionPresentation' &&
    call.arguments.some(argument => ts.isCallExpression(argument) && argument.expression.getText(tree) === 'createVisibleActiveSessionRunProjector'))).toBe(true);
  expect(calls.some(call => call.expression.getText(tree) === 'presentation.present' &&
    call.arguments.map(argument => argument.getText(tree)).join(',') === 'record,params')).toBe(true);
  const presentation = source('src/gateway/session-row-presentation.ts');
  const properties: ts.PropertyAssignment[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(presentation) === 'activeRunIds') properties.push(node);
    ts.forEachChild(node, collect);
  };
  collect(presentation);
  expect(properties).toHaveLength(1);
  expect(properties[0].initializer.getText(presentation)).toBe('run.runIds');
});
