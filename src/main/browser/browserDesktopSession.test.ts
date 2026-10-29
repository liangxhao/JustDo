import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMBEDDED_BROWSER_REQUESTED_EVENT } from '../../../plugins/extensions/embedded-browser/browserExecutionContract';
import { buildCoworkSessionKey } from '../../shared/cowork/sessionKey';
import { CoworkStore } from '../data/coworkStore';
import { SqliteStore } from '../data/sqliteStore';
import { resolveBrowserDesktopSession } from './browserDesktopSession';
import { EmbeddedBrowserGatewayBridge } from './embeddedBrowserGatewayBridge';

vi.mock('electron', () => ({ app: {} }));

describe('desktop browser session ownership', () => {
  let directory: string;
  let database: SqliteStore;
  let store: CoworkStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-session-'));
    database = SqliteStore.create(directory);
    store = new CoworkStore(database.getDatabase());
  });

  afterEach(() => {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it.each(['main', 'research'])('admits a normal %s chat without a persisted native-key binding', async agentId => {
    const session = store.createSession('Browser task', directory, 'local', [], agentId);
    const sessionKey = buildCoworkSessionKey(session.id, agentId);
    // Normal chats derive their key; they are neither adopted native children nor imports.
    expect(store.getSessionByNativeKey(sessionKey)).toBeNull();
    expect(resolveBrowserDesktopSession(store, sessionKey)?.id).toBe(session.id);
    const execute = vi.fn(async () => ({ ok: true }));
    const resolve = vi.fn(async () => undefined);
    const bridge = new EmbeddedBrowserGatewayBridge({
      isEnabled: () => true,
      getDesktopSession: key => resolveBrowserDesktopSession(store, key),
      getScheduledTask: async () => null,
      execute,
      resolve,
      releaseScope: vi.fn(),
      revokeAll: vi.fn(),
    });

    bridge.handleEvent({
      event: EMBEDDED_BROWSER_REQUESTED_EVENT,
      payload: {
        requestId: 'request-1',
        sessionKey,
        run: { sessionKey, sessionId: 'native-1', runId: 'run-1', trigger: 'user', workspaceDir: directory },
        toolCallId: 'call-1',
        command: { action: 'open', url: 'https://example.com' },
        policy: { allowLocalFiles: true },
      },
    });

    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith('request-1', { ok: true, result: { ok: true } }));
    expect(execute).toHaveBeenCalledWith(sessionKey, expect.objectContaining({ action: 'open' }), expect.any(AbortSignal), {
      sessionId: session.id,
      runId: 'run-1',
      workspaceDir: directory,
      headlessOnly: false,
      allowLocalFiles: true,
    });
  });

  it('retains an exact imported binding whose native key differs from the local row ID', () => {
    const session = store.createSession('Imported chat', directory);
    const sessionKey = buildCoworkSessionKey('imported-native-key');
    database.getDatabase().prepare(`
      INSERT INTO history_session_bindings (
        session_id,session_key,native_session_id,availability,source_agent_id,source_session_key,transaction_id
      ) VALUES (?,?,?,'native','main',?,'browser-test')
    `).run(session.id, sessionKey, 'native-import', sessionKey);

    expect(resolveBrowserDesktopSession(store, sessionKey)).toMatchObject({
      id: session.id,
      historyBinding: { nativeSessionId: 'native-import' },
    });
    expect(resolveBrowserDesktopSession(store, buildCoworkSessionKey(session.id))).toBeNull();
  });

  it('preserves explicit native bindings and rejects stale keys and wrong assistant ownership', () => {
    const session = store.createSession('Bound chat', directory, 'local', [], 'research');
    const nativeKey = buildCoworkSessionKey('native-key', 'research');
    store.bindNativeSession(session.id, nativeKey, null);
    expect(resolveBrowserDesktopSession(store, nativeKey)?.id).toBe(session.id);
    expect(resolveBrowserDesktopSession(store, buildCoworkSessionKey(session.id, 'research'))).toBeNull();
    store.bindNativeSession(session.id, buildCoworkSessionKey('native-key', 'other'), null);
    expect(resolveBrowserDesktopSession(store, buildCoworkSessionKey('native-key', 'other'))).toBeNull();
  });

  it('rejects missing, cross-assistant, partial and noncanonical keys', () => {
    const session = store.createSession('Chat', directory);
    const canonical = buildCoworkSessionKey(session.id);
    for (const key of [
      buildCoworkSessionKey('missing'),
      buildCoworkSessionKey(session.id, 'other'),
      `justdo:${session.id}`,
      `${canonical}:execution:child`,
      ` ${canonical}`,
      `${canonical} `,
      `agent:main:cron:${session.id}`,
    ]) expect(resolveBrowserDesktopSession(store, key)).toBeNull();
  });
});
