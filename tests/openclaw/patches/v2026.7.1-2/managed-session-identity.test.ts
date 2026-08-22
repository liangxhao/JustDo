import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const identityPatch =
  require('../../../../scripts/patches/v2026.7.1-2/036-managed-session-identity-pin.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

const temporaryRoots: string[] = [];

const COMMAND_FIXTURE = `
function clearRotatedSessionMetadata(sessionEntry) { return { ...sessionEntry, cleared: true }; }
function resolveSession(opts) {
  const sessionKey = opts.sessionKey;
  const sessionEntry = opts.sessionEntry;
  const requestedSessionId = opts.sessionId?.trim() || void 0;
  const terminalMainTranscriptNewerThanRegistry = opts.terminal;
  const fresh = opts.fresh;
  const sessionId = requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || crypto.randomUUID();
  const isNewSession = !fresh && !requestedSessionId;
  const resolvedSessionEntry = isNewSession && sessionEntry ? clearRotatedSessionMetadata(sessionEntry) : sessionEntry;
  return { sessionId, isNewSession, resolvedSessionEntry, terminalMainTranscriptNewerThanRegistry };
}
`;

const AGENT_FIXTURE = `
function resolveFailedSessionTranscriptMissingForEntry() { return false; }
function resolveGatewaySession(canonicalKey, entry, freshness, requestedSessionId) {
  const failedSessionTranscriptMissing = true;
  const terminalMainTranscriptNewerThanRegistry = true;
  const canReuseSession = Boolean(entry?.sessionId) && (freshness?.fresh ?? false) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry;
  let usableRequestedSessionId = requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;
  const sessionId = usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? randomUUID();
  const buildSessionPatch = (freshEntry) => {
    const freshFreshness = freshness;
    const freshFailedSessionTranscriptMissing = true;
    const freshTerminalMainTranscriptNewerThanRegistry = true;
    const freshCanReuseSession = Boolean(freshEntry?.sessionId) && (freshFreshness?.fresh ?? false) && !freshFailedSessionTranscriptMissing && !freshTerminalMainTranscriptNewerThanRegistry;
    const freshUsableRequestedSessionId = requestedSessionId && (!freshEntry?.sessionId || freshCanReuseSession) ? requestedSessionId : void 0;
    const freshSessionId = freshUsableRequestedSessionId ? freshUsableRequestedSessionId : (freshCanReuseSession ? freshEntry?.sessionId : void 0) ?? sessionId;
    const freshIsNewSession = !freshEntry || !freshCanReuseSession && !freshUsableRequestedSessionId;
    return { freshSessionId, freshIsNewSession, freshCanReuseSession };
  };
  return { sessionId, canReuseSession, ...buildSessionPatch(entry) };
}
`;

const REPLY_FIXTURE = `
function initReplySession(sessionKey, entry, resetTriggered, isNewSession, freshEntry) {
  const canReuseExistingEntry = Boolean(entry?.sessionId) && typeof entry?.updatedAt === "number" && Number.isFinite(entry.updatedAt);
  const effectiveFreshEntry = freshEntry;
  const previousSessionEntry = (resetTriggered || !effectiveFreshEntry) && entry ? { ...entry } : void 0;
  const reusableEntry = entry;
  let sessionId;
  if (!isNewSession && effectiveFreshEntry && canReuseExistingEntry && reusableEntry) {
    sessionId = reusableEntry.sessionId;
  } else {
    sessionId = cryptoReply.randomUUID();
    isNewSession = true;
  }
  return { sessionId, isNewSession, effectiveFreshEntry, previousSessionEntry };
}
`;

function createRuntime(agentFixture = AGENT_FIXTURE): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-managed-identity-'));
  temporaryRoots.push(root);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'command.js'), COMMAND_FIXTURE);
  fs.writeFileSync(path.join(root, 'dist', 'agent.js'), agentFixture);
  fs.writeFileSync(path.join(root, 'dist', 'reply.js'), REPLY_FIXTURE);
  fs.writeFileSync(
    path.join(root, 'gateway-bundle.mjs'),
    [COMMAND_FIXTURE, agentFixture, REPLY_FIXTURE].join('\n'),
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('managed session identity pin capability', () => {
  test('pins both command and Gateway persistence decisions while leaving native sessions unchanged', () => {
    const root = createRuntime();
    expect(identityPatch.applyPatch(root).sort()).toEqual([
      path.join('dist', 'agent.js'),
      path.join('dist', 'command.js'),
      path.join('dist', 'reply.js'),
      'gateway-bundle.mjs',
    ]);
    identityPatch.verifyPatch(root);
    expect(identityPatch.applyPatch(root)).toEqual([]);

    const commandSource = fs.readFileSync(path.join(root, 'dist', 'command.js'), 'utf8');
    const resolveSession = new Function('crypto', `${commandSource}; return resolveSession;`)({
      randomUUID: () => 'generated-command',
    }) as (opts: Record<string, unknown>) => {
      sessionId: string;
      isNewSession: boolean;
      resolvedSessionEntry?: { cleared?: boolean };
    };
    expect(
      resolveSession({
        sessionKey: 'agent:main:justdo:task',
        sessionEntry: { sessionId: 'stable' },
        sessionId: 'stale-client-id',
        fresh: false,
      }),
    ).toMatchObject({ sessionId: 'stable', isNewSession: false });
    expect(
      resolveSession({
        sessionKey: 'agent:main:native:task',
        sessionEntry: { sessionId: 'native-old' },
        fresh: false,
      }),
    ).toMatchObject({
      sessionId: 'generated-command',
      isNewSession: true,
      resolvedSessionEntry: { cleared: true },
    });

    const agentSource = fs.readFileSync(path.join(root, 'dist', 'agent.js'), 'utf8');
    const resolveGatewaySession = new Function(
      'randomUUID',
      `${agentSource}; return resolveGatewaySession;`,
    )(() => 'generated-gateway') as (
      key: string,
      entry: { sessionId: string },
      freshness: { fresh: boolean },
      requested?: string,
    ) => Record<string, unknown>;
    expect(
      resolveGatewaySession(
        'agent:main:justdo:task',
        { sessionId: 'stable' },
        { fresh: false },
        'stale-client-id',
      ),
    ).toMatchObject({
      sessionId: 'stable',
      canReuseSession: true,
      freshSessionId: 'stable',
      freshIsNewSession: false,
      freshCanReuseSession: true,
    });
    expect(
      resolveGatewaySession(
        'agent:main:native:task',
        { sessionId: 'native-old' },
        { fresh: false },
      ),
    ).toMatchObject({
      sessionId: 'generated-gateway',
      canReuseSession: false,
      freshSessionId: 'generated-gateway',
      freshIsNewSession: true,
      freshCanReuseSession: false,
    });

    const replySource = fs.readFileSync(path.join(root, 'dist', 'reply.js'), 'utf8');
    const initReplySession = new Function(
      'cryptoReply',
      `${replySource}; return initReplySession;`,
    )({ randomUUID: () => 'generated-reply' }) as (
      key: string,
      entry: { sessionId: string; updatedAt?: number },
      resetTriggered: boolean,
      isNewSession: boolean,
      freshEntry: boolean,
    ) => Record<string, unknown>;
    expect(
      initReplySession('agent:main:justdo:task', { sessionId: 'stable' }, false, false, false),
    ).toMatchObject({
      sessionId: 'stable',
      isNewSession: false,
      effectiveFreshEntry: true,
    });
    expect(
      initReplySession(
        'agent:main:justdo:task',
        { sessionId: 'stable', updatedAt: 1 },
        true,
        true,
        true,
      ),
    ).toMatchObject({ sessionId: 'generated-reply', isNewSession: true });
    expect(
      initReplySession(
        'agent:main:native:task',
        { sessionId: 'native-old', updatedAt: 1 },
        false,
        false,
        false,
      ),
    ).toMatchObject({ sessionId: 'generated-reply', isNewSession: true });

    const bundleSource = fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8');
    for (const marker of [
      'JUSTDO_MANAGED_COMMAND_SESSION_IDENTITY_PIN',
      'JUSTDO_MANAGED_AGENT_SESSION_IDENTITY_PIN',
      'JUSTDO_MANAGED_REPLY_SESSION_IDENTITY_PIN',
    ]) {
      expect(bundleSource).toContain(marker);
    }

    for (const filePath of [
      path.join(root, 'dist', 'agent.js'),
      path.join(root, 'dist', 'command.js'),
      path.join(root, 'dist', 'reply.js'),
      path.join(root, 'gateway-bundle.mjs'),
    ]) {
      const withoutCommentMarkers = fs
        .readFileSync(filePath, 'utf8')
        .replace(/JUSTDO_MANAGED_(?:COMMAND|AGENT|REPLY)_SESSION_IDENTITY_PIN_V2026_7_1_2/gu, '');
      fs.writeFileSync(filePath, withoutCommentMarkers);
    }
    identityPatch.verifyPatch(root);
    expect(identityPatch.applyPatch(root)).toEqual([]);
  });

  test('stages every resolver before writing any target', () => {
    const brokenAgent = AGENT_FIXTURE.replace(
      'const freshCanReuseSession = Boolean(freshEntry?.sessionId)',
      'const brokenFreshCanReuseSession = Boolean(freshEntry?.sessionId)',
    );
    const root = createRuntime(brokenAgent);
    const commandPath = path.join(root, 'dist', 'command.js');
    const originalCommand = fs.readFileSync(commandPath, 'utf8');

    expect(() => identityPatch.applyPatch(root)).toThrow(/persisted identity anchor count is 0/);
    expect(fs.readFileSync(commandPath, 'utf8')).toBe(originalCommand);
  });
});
