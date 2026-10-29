import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '../../../renderer/libs/openclaw-chat/model/timeline/project-history-timeline';
import type { GatewayMessage } from '../../../renderer/libs/openclaw-chat/types';
import { DB_FILENAME } from '../../core/appConstants';
import { planLegacyHistory, stageLegacyHistory } from './legacyHistory';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const roots: string[] = [];
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-tool-stage-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function history(sessionId: string): string {
  return [
    { type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '' },
    { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Old task' }] } },
    { type: 'message', id: 'read', parentId: 'user', message: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'read-call', name: 'read', arguments: { path: 'old.txt' } }],
    } },
    { type: 'message', id: 'yield', parentId: 'read', message: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'yield-call', name: 'sessions_yield', arguments: { message: 'Wait' } }],
    } },
    { type: 'message', id: 'empty-result', parentId: 'yield', message: {
      role: 'toolResult', toolCallId: 'yield-call', toolName: 'sessions_yield', content: [], isError: false,
    } },
    { type: 'message', id: 'final', parentId: 'empty-result', message: {
      role: 'assistant', content: [{ type: 'text', text: 'The final historical answer.' }], stopReason: 'stop',
    } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n';
}

test('staging closes primary, side, child and compaction Tools without changing backup originals', () => {
  const source = root();
  const sourceFolder = path.join(source, 'openclaw/state/agents/main/sessions');
  fs.mkdirSync(sourceFolder, { recursive: true });
  const db = new Database(path.join(source, DB_FILENAME));
  try {
    db.exec(`CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,title TEXT,agent_id TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER);
      INSERT INTO cowork_sessions VALUES ('legacy','Old task','main','',1000,2000);`);
  } finally {
    db.close();
  }
  const filenames = ['历史会话.jsonl', 'legacy-native.compaction.jsonl', 'before.jsonl', 'after.jsonl'];
  const original = history('legacy-native');
  for (const filename of filenames) fs.writeFileSync(path.join(sourceFolder, filename), original);
  const child = history('worker-native');
  fs.writeFileSync(path.join(sourceFolder, 'worker-native.jsonl'), child);
  fs.writeFileSync(path.join(sourceFolder, 'sessions.json'), JSON.stringify({
    'agent:main:justdo:legacy': {
      sessionId: 'legacy-native', updatedAt: 2000, sessionFile: 'C:/previous/history/历史会话.jsonl',
      compactionCheckpoints: [{
        preCompaction: { sessionFile: 'C:/previous/history/before.jsonl' },
        postCompaction: { sessionFile: 'C:/previous/history/after.jsonl' },
      }],
    },
    'agent:main:subagent:worker': {
      sessionId: 'worker-native', updatedAt: 2000, spawnedBy: 'agent:main:justdo:legacy',
    },
  }));
  const plan = planLegacyHistory(source);
  const target = root();
  stageLegacyHistory(source, target, plan);
  const targetFolder = path.join(target, 'agents/main/sessions');
  const staged = new Map<string, string>();
  for (const filename of [...filenames, 'worker-native.jsonl']) {
    const output = fs.readFileSync(path.join(targetFolder, filename), 'utf8');
    staged.set(filename, output);
    const records = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const messages: GatewayMessage[] = records
      .filter(record => record.type === 'message')
      .map(record => ({ ...record.message, __openclaw: { id: record.id } }));
    const timeline = projectPersistedTimeline(messages);
    const tools = timeline.flatMap(item => item.kind === 'process-summary'
      ? item.items.filter(process => process.type === 'tool') : []);
    expect(timeline.some(item => item.kind === 'live-process')).toBe(false);
    expect(tools.map(tool => tool.toolCallId).sort()).toEqual(['read-call', 'yield-call']);
    expect(tools.every(tool => tool.status !== 'running')).toBe(true);
    expect(records.find(record => record.id === 'final')?.message.content).toEqual([
      { type: 'text', text: 'The final historical answer.' },
    ]);
    expect(fs.readFileSync(path.join(sourceFolder, filename), 'utf8')).toBe(
      filename === 'worker-native.jsonl' ? child : original,
    );
  }
  // Identical snapshots must stay identical for native history import de-duplication.
  expect(new Set(filenames.map(filename => staged.get(filename))).size).toBe(1);
  stageLegacyHistory(source, target, plan);
  for (const [filename, output] of staged)
    expect(fs.readFileSync(path.join(targetFolder, filename), 'utf8')).toBe(output);
});
