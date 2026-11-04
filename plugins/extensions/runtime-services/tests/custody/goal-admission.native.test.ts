import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

import { registerCustody } from '../../custody/service';
import { INERT_CUSTODY_HARNESS } from '../../sdk/custody';

vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({}));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({}));

// Opt-in published-function conformance. No Gateway, model or user storage is opened.
const runtimeRoot = process.env.OPENCLAW_NATIVE_PACKAGE_ROOT;
const requireNative = createRequire(import.meta.url);
function nativeSource(prefix: string, declaration?: string) {
  const dist = path.join(runtimeRoot!, 'dist');
  const files = readdirSync(dist).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))
    .filter(name => !declaration || readFileSync(path.join(dist, name), 'utf8').includes(`function ${declaration}(`));
  expect(files).toHaveLength(1);
  const file = path.join(dist, files[0]);
  const source = readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { file, source, tree };
}
function nativeDeclarations(owner: ReturnType<typeof nativeSource>, names: string[]) {
  return names.map(name => {
    const nodes = owner.tree.statements.filter(node =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
      (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(owner.tree) === name)));
    expect(nodes, name).toHaveLength(1);
    return nodes[0].getText(owner.tree);
  }).join('\n');
}
function nativeExports(prefix: string): Record<string, unknown> {
  const owner = nativeSource(prefix);
  const exports = owner.tree.statements.filter(ts.isExportDeclaration).flatMap(node =>
    node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []);
  const module = requireNative(owner.file);
  return Object.fromEntries(exports.map(item => [(item.propertyName ?? item.name).text, module[item.name.text]]));
}

describe.skipIf(!runtimeRoot)('custody and locked native Goal admission', () => {
  test('does not obstruct Goal start/resume while native work and storage ownership guards remain active', () => {
    const metadata = JSON.parse(readFileSync(path.join(runtimeRoot!, 'package.json'), 'utf8'));
    expect(metadata.name).toBe('openclaw');
    expect(metadata.version).toBe('2026.10.7');
    const hooks = new Set<string>();
    registerCustody({
      id: 'runtime-services',
      on: (name: string) => hooks.add(name),
      registerAgentHarness() {}, registerService() {}, registerGatewayMethod() {},
    } as never, { scope: 'goal-admission-fixture', resolve: () => undefined, dispose() {} });

    const owner = nativeSource('chat-send-handler-', 'resolveRestartSafeChatAdmission');
    const native = nativeDeclarations(owner, [
      'RESTART_RECOVERY_UNSAFE_CHAT_ADMISSION_HOOKS', 'findRestartRecoveryUnsafeChatAdmissionHook',
      'isRestartSafeChatSession', 'hasRestartUnsafeChatWork', 'resolveRestartSafeChatAdmission',
    ]);
    const harness = nativeExports('agent-harness-session-key-');
    const admit = vm.runInNewContext(`${native}\nresolveRestartSafeChatAdmission`, {
      ...harness,
      hasGlobalHooks: (name: string) => hooks.has(name),
      resolveSessionDispatchKind: () => 'agent',
      resolveProjectedAgentRunProgressState: () => undefined,
      listActiveEmbeddedRunSessionIds: () => [], replyRunRegistry: { isActive: () => false },
      isSubagentSessionKey: () => false, isCronSessionKey: () => false, isAcpSessionKey: () => false,
      isRetryableUnadoptedChatClaim: () => false,
      resolveChatRunOwnerAgentId: ({ agentId }: { agentId: string }) => agentId,
      isIncognitoSessionKey: () => false, resolveChannelResetConfig: () => undefined,
      sessionDeliveryChannel: () => undefined, resolveSessionResetType: () => 'direct',
      resolvePreparedSessionEntryResetFreshness: () => ({ state: 'fresh' }),
    });
    const entry = { sessionId: 'native-goal' };
    const params = {
      entry, lifecycleTimestamps: {}, cfg: {}, requestedSessionId: entry.sessionId,
      sessionId: entry.sessionId, sessionKey: 'agent:main:goal-fixture', agentId: 'main',
      request: { fingerprint: 'goal-request' }, context: { chatAbortControllers: new Map() },
    };
    expect(admit(params)).toEqual({ requestFingerprint: 'goal-request' });
    expect(admit({ ...params, allowAbortedLastRun: true, entry: { ...entry, abortedLastRun: true } }))
      .toEqual({ requestFingerprint: 'goal-request' });
    params.context.chatAbortControllers.set('busy', { agentId: 'main', sessionKey: params.sessionKey });
    expect(admit(params)).toBeUndefined();
    params.context.chatAbortControllers.clear();
    // Reproduce the original failure through the actual native hook policy.
    hooks.add('before_agent_run');
    expect(admit(params)).toBeUndefined();
    hooks.clear();
    expect(admit({ ...params, entry: { ...entry, agentHarnessId: INERT_CUSTODY_HARNESS } })).toBeUndefined();

    const checkOwnership = vm.runInNewContext(
      `${nativeDeclarations(nativeSource('embedded-agent-', 'resolveAgentHarnessRunAdmissionError'), ['resolveAgentHarnessRunAdmissionError'])}\nresolveAgentHarnessRunAdmissionError`,
      { ...harness, ...nativeExports('agent-runtime-id-') },
    );
    const locked = {
      entry: { ...entry, agentHarnessId: INERT_CUSTODY_HARNESS, modelSelectionLocked: true },
      sessionKey: `agent:main:harness:${INERT_CUSTODY_HARNESS}:fixture:1`, sessionId: entry.sessionId,
      agentHarnessId: INERT_CUSTODY_HARNESS, modelSelectionLocked: true,
    };
    expect(checkOwnership(locked)).toBeUndefined();
    for (const change of [
      { agentHarnessId: undefined }, { agentHarnessId: 'openclaw' },
      { modelSelectionLocked: false }, { sessionId: 'replacement' }, { entry: undefined },
    ]) expect(checkOwnership({ ...locked, ...change })).toBeTypeOf('string');
  });
});
