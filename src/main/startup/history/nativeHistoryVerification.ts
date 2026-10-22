/** Runs inside the bundled Node runtime. Public native readers own every SQLite read.
 * Only identity/count evidence returns to Main, never transcript bodies.
 */
export const NATIVE_HISTORY_VERIFICATION_SOURCE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [runtimeRoot, stateDir, planFile] = process.argv.slice(1);
const sdk = await import(pathToFileURL(path.join(runtimeRoot, 'dist/plugin-sdk/session-store-runtime.js')).href);
if (typeof sdk.getSessionEntry !== 'function') throw new Error('The bundled native history reader is unavailable.');
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const expected = new Map();
function add(agentId, key, sessionId, spawnedBy) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId) || typeof key !== 'string' || !key ||
    typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid native history verification identity.');
  const identity = JSON.stringify([agentId, key]);
  const previous = expected.get(identity);
  if (previous && previous.sessionId !== sessionId) throw new Error('Conflicting native import identities.');
  expected.set(identity, { agentId, key, sessionId, spawnedBy: spawnedBy ?? previous?.spawnedBy });
}
for (const agent of plan.agents) for (const [key, entry] of Object.entries(agent.entries))
  add(agent.agentId, key, entry.sessionId, entry.spawnedBy);
for (const row of plan.conversations) add(row.agentId, row.sessionKey, row.nativeSessionId);
let parentLinks = 0;
for (const row of expected.values()) {
  const entry = sdk.getSessionEntry({ agentId: row.agentId, sessionKey: row.key,
    storePath: path.join(stateDir, 'agents', row.agentId, 'sessions', 'sessions.json') });
  if (entry?.sessionId !== row.sessionId) throw new Error('An imported native conversation identity could not be verified.');
  if (row.spawnedBy !== undefined) {
    if (entry.spawnedBy !== row.spawnedBy) throw new Error('An imported native parent association changed.');
    parentLinks++;
  }
}
process.stdout.write(JSON.stringify({ verified: true, entries: expected.size,
  conversations: plan.conversations.length, parentLinks }));
`;
