import fs from 'node:fs';
import path from 'node:path';

import type { ExternalAgentThread } from './externalAgentTypes';

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional client discovery hint. This never reads or authorizes native history. */
export function prepareCodexSessionMarker(home: string): (thread: ExternalAgentThread) => void {
  if (!home.trim() || home.includes('\0') || !path.isAbsolute(home))
    throw new Error('CODEX_HOME must be an absolute directory.');
  const directory = path.join(home, 'sessions');
  // Clients may link their sessions directory to another client-owned store.
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const realDirectory = fs.realpathSync(directory);
  if (!fs.statSync(realDirectory).isDirectory())
    throw new Error('The client session marker directory is unavailable.');
  return thread => {
    if (!THREAD_ID.test(thread.id) || !path.isAbsolute(thread.cwd) || thread.cwd.includes('\0'))
      throw new Error('Invalid client session marker identity.');
    const target = path.join(realDirectory, `rollout-external-${thread.id}.jsonl`);
    const content = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: thread.id, originator: 'external-agent', cwd: thread.cwd },
    })}\n`;
    try {
      fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.lstatSync(target).isFile())
        throw error;
      if (
        fs.statSync(target).size !== Buffer.byteLength(content) ||
        fs.readFileSync(target, 'utf8') !== content
      )
        throw new Error('The client session marker has conflicting ownership.');
    }
  };
}
