import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain } from 'electron';

import {
  type SessionReviewDiff,
  type SessionReviewFileAction,
  type SessionReviewFileResult,
  SessionReviewIpc,
  type SessionReviewQuery,
  type SessionReviewResult,
} from '../../../shared/cowork/sessionReview';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { openPathWithSystemChooser } from '../app/shell';

interface Dependencies {
  getRuntime: () => {
    getGatewayClient: () => GatewayClientLike | null;
    getSessionKeysForSession: (id: string) => string[];
  } | null;
  getSession: (id: string) => { cwd?: string; agentId?: string | null } | null | undefined;
}
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const hasGitMetadataSegment = (filePath: string) =>
  filePath.split(/[\\/]/).some(part => part.toLowerCase() === '.git');
export async function resolveReviewFile(
  root: string | undefined,
  cwd: string | undefined,
  relative: string,
): Promise<{ filePath: string; relativePath: string }> {
  if (
    !root ||
    !cwd ||
    !relative ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.includes('\0') ||
    relative.includes(':') ||
    relative.split(/[\\/]/).some(part => part === '..') ||
    hasGitMetadataSegment(relative)
  )
    throw new Error('file');
  const [canonicalRoot, canonicalCwd] = await Promise.all([fs.realpath(root), fs.realpath(cwd)]);
  const candidate = path.resolve(canonicalRoot, relative);
  const canonicalFile = await fs.realpath(candidate);
  if (
    !within(canonicalRoot, candidate) ||
    !within(canonicalRoot, canonicalFile) ||
    !within(canonicalCwd, canonicalFile) ||
    hasGitMetadataSegment(path.relative(canonicalRoot, canonicalFile))
  )
    throw new Error('file');
  const info = await fs.stat(canonicalFile);
  // Match native diff's content boundary: realpath cannot expose a hardlink's
  // other names, which may live outside the authorized checkout.
  if (!info.isFile() || info.nlink !== 1) throw new Error('file');
  return {
    filePath: canonicalFile,
    relativePath: path.relative(canonicalCwd, canonicalFile).replace(/\\/g, '/'),
  };
}
export function createSessionReviewService(deps: Dependencies) {
  async function read(
    query: SessionReviewQuery,
  ): Promise<{ diff: SessionReviewDiff; verifyCurrent: () => Promise<void> }> {
    if (
      !query ||
      typeof query.sessionId !== 'string' ||
      !['all', 'uncommitted', 'commit'].includes(query.scope) ||
      (query.scope === 'commit'
        ? typeof query.commit !== 'string' || !query.commit.trim() || query.commit.length > 200
        : query.commit !== undefined)
    )
      throw new Error('invalid');
    const session = deps.getSession(query.sessionId);
    if (!session) throw new Error('identity');
    const cwd = session.cwd;
    const agentId = session.agentId;
    const runtime = deps.getRuntime();
    const client = runtime?.getGatewayClient();
    if (!runtime || !client) throw new Error('unavailable');
    const keys = runtime.getSessionKeysForSession(query.sessionId);
    const assertCurrent = () => {
      const current = deps.getSession(query.sessionId);
      if (
        !current ||
        current.cwd !== cwd ||
        current.agentId !== agentId ||
        deps.getRuntime() !== runtime ||
        runtime.getGatewayClient() !== client ||
        JSON.stringify(runtime.getSessionKeysForSession(query.sessionId)) !== JSON.stringify(keys)
      )
        throw new Error('identity');
    };
    for (const sessionKey of keys) {
      const params = {
        sessionKey,
        scope: query.scope,
        ...(query.commit ? { commit: query.commit } : {}),
      };
      const before = await client.request<{ session?: { sessionId?: string } }>(
        'sessions.describe',
        { key: sessionKey },
      );
      assertCurrent();
      if (!before.session?.sessionId) continue;
      const diff = await client.request<SessionReviewDiff>('sessions.diff', params);
      const after = await client.request<{ session?: { sessionId?: string } }>(
        'sessions.describe',
        { key: sessionKey },
      );
      assertCurrent();
      if (before.session.sessionId !== after.session?.sessionId || diff.sessionKey !== sessionKey)
        throw new Error('identity');
      if (!Array.isArray(diff.files)) throw new Error('invalid');
      return {
        diff,
        verifyCurrent: async () => {
          const latest = await client.request<{ session?: { sessionId?: string } }>(
            'sessions.describe',
            { key: sessionKey },
          );
          assertCurrent();
          if (latest.session?.sessionId !== before.session?.sessionId) throw new Error('identity');
        },
      };
    }
    return {
      verifyCurrent: async () => {
        assertCurrent();
      },
      diff: {
        sessionKey: keys[0] ?? query.sessionId,
        files: [],
        additions: 0,
        deletions: 0,
        unavailableReason: 'unknown_session',
      },
    };
  }
  function failure(error: unknown): {
    success: false;
    reason: 'invalid' | 'identity' | 'unsupported' | 'unavailable' | 'file';
  } {
    const message = error instanceof Error ? error.message : '';
    if (message === 'identity' || message === 'invalid' || message === 'file')
      return { success: false, reason: message };
    // Only explicit unknown-method errors identify an unsupported runtime.
    return {
      success: false,
      reason:
        /unknown method[: ]+sessions\.diff|method not found.*sessions\.diff/i.test(
          message,
        )
          ? 'unsupported'
          : 'unavailable',
    };
  }
  return {
    async load(query: SessionReviewQuery): Promise<SessionReviewResult> {
      try {
        return { success: true, diff: (await read(query)).diff };
      } catch (error) {
        return failure(error);
      }
    },
    async file(
      query: SessionReviewQuery,
      relative: string,
      action: SessionReviewFileAction,
    ): Promise<SessionReviewFileResult> {
      try {
        if (!['preview', 'files', 'editor'].includes(action) || typeof relative !== 'string')
          throw new Error('invalid');
        const { diff, verifyCurrent } = await read(query);
        const file = diff.files.find(item => item.path === relative);
        if (!file || file.status === 'deleted') throw new Error('file');
        const resolved = await resolveReviewFile(
          diff.root,
          deps.getSession(query.sessionId)?.cwd,
          relative,
        );
        await verifyCurrent();
        if (action === 'editor' && !(await openPathWithSystemChooser(resolved.filePath)).success)
          throw new Error('file');
        return { success: true, ...resolved };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
export function registerSessionReviewHandlers(deps: Dependencies): void {
  const service = createSessionReviewService(deps);
  ipcMain.handle(SessionReviewIpc.Load, (event, query: SessionReviewQuery) =>
    event.sender.getType() === 'window'
      ? service.load(query)
      : { success: false, reason: 'identity' },
  );
  ipcMain.handle(
    SessionReviewIpc.File,
    (event, query: SessionReviewQuery, relative: string, action: SessionReviewFileAction) =>
      event.sender.getType() === 'window'
        ? service.file(query, relative, action)
        : { success: false, reason: 'identity' },
  );
}
