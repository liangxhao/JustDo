import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type Database from 'better-sqlite3';

import { parseAssistantCreate } from '../../../shared/agents/agents';
import type { CoworkStore } from '../../data/coworkStore';
import { resolveManagedAgentWorkspace } from './agentWorkspace';

interface Dependencies {
  getDatabase: () => Database.Database;
  getStore: () => CoworkStore;
  getStateDir: () => string;
  exclusive: <T>(operation: () => Promise<T>) => Promise<T>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  onChanged: () => void;
}
export interface AssistantCreationResult {
  status: 'created' | 'existing' | 'incomplete';
  agentId: string;
  name: string;
  enabled?: boolean;
  error?: string;
}
interface CreationRecord {
  digest: string;
  stage: 'preparing' | 'ready';
}
const RECORD_PREFIX = 'assistantCreation:';
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');

/** Thin native management adapter. No execution scheduling or message persistence. */
export class NativeAssistantCreation {
  constructor(private readonly deps: Dependencies) {}

  create(
    raw: unknown,
    identity: string,
    assertActive: () => void,
  ): Promise<AssistantCreationResult> {
    const input = parseAssistantCreate(raw);
    const digest = digestOf(JSON.stringify(input));
    return this.deps.exclusive<AssistantCreationResult>(async () => {
      assertActive();
      const db = this.deps.getDatabase();
      const store = this.deps.getStore();
      let id = `agent-${digestOf(identity).slice(0, 32)}`;
      const readRecord = (agentId: string): CreationRecord | undefined => {
        const row = db
          .prepare('SELECT value FROM kv WHERE key = ?')
          .get(RECORD_PREFIX + agentId) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as CreationRecord) : undefined;
      };
      let record = readRecord(id);
      // An interrupted creation can be deleted before its original tool call retries.
      // Reject it before any native profile or role-file writes, not only at final save.
      if (store.getAgent(id)?.deletedAt) throw new Error('agentUnavailable');
      if (record && record.digest !== digest) throw new Error('agentCreationConflict');
      if (!record) {
        const sameName = store
          .listAgents()
          .filter(agent => !agent.deletedAt)
          .find(
            agent =>
              agent.name.normalize('NFKC').toLowerCase() ===
              input.name.normalize('NFKC').toLowerCase(),
          );
        if (sameName) {
          id = sameName.id;
          record = readRecord(id);
          if (!record || record.stage === 'ready')
            return {
              status: 'existing',
              agentId: id,
              name: sameName.name,
              enabled: sameName.enabled,
            };
          if (record.digest !== digest) throw new Error('agentCreationConflict');
        }
      }
      if (record?.stage === 'ready') {
        const existing = store.getAgent(id);
        if (!existing || existing.deletedAt) throw new Error('agentUnavailable');
        return { status: 'existing', agentId: id, name: existing.name, enabled: existing.enabled };
      }
      if (input.model) {
        const catalog = await this.deps.requestGateway<{
          models: Array<{ id: string; provider: string }>;
        }>('models.list');
        if (!catalog.models?.some(model => `${model.provider}/${model.id}` === input.model))
          throw new Error('agentInvalidModel');
      }
      assertActive();
      const profile = {
        id,
        name: input.name,
        description: input.description,
        icon: '',
        model: input.model ?? '',
        enabled: false,
        isDefault: false,
      };
      if (!record)
        db.transaction(() => {
          if (store.getAgent(id)) throw new Error('agentCreationConflict');
          store.saveAgentProfile(profile);
          db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
            RECORD_PREFIX + id,
            JSON.stringify({ digest, stage: 'preparing' }),
            Date.now(),
          );
        })();
      const workspace = resolveManagedAgentWorkspace(this.deps.getStateDir(), '', id);
      try {
        const roster = await this.deps.requestGateway<{ agents: Array<{ id: string }> }>(
          'agents.list',
        );
        if (!roster.agents?.some(agent => agent.id === id)) {
          assertActive();
          const created = await this.deps.requestGateway<{
            ok: boolean;
            agentId: string;
            workspace: string;
          }>('agents.create', {
            name: id,
            workspace,
            ...(input.model ? { model: input.model } : {}),
          });
          if (
            !created.ok ||
            created.agentId !== id ||
            path.resolve(created.workspace) !== path.resolve(workspace)
          )
            throw new Error('agentRuntimeUnknown');
          // Native config writes complete before the Gateway's runtime snapshot hot reloads.
          // Wait for visibility, without restarting the caller's running conversation.
          const visibleBy = Date.now() + 10000;
          for (;;) {
            assertActive();
            const visible = await this.deps.requestGateway<{ agents: Array<{ id: string }> }>(
              'agents.list',
            );
            if (visible.agents?.some(agent => agent.id === id)) break;
            if (Date.now() >= visibleBy) throw new Error('agentRuntimeUnknown');
            await delay(200);
          }
        }
        assertActive();
        // Native creation derives IDs from name; set the user-facing (possibly Chinese) name separately.
        await this.deps.requestGateway('agents.update', {
          agentId: id,
          name: input.name,
          ...(input.model ? { model: input.model } : {}),
        });
        assertActive();
        const current = await this.deps.requestGateway<{ workspace: string }>('agents.files.get', {
          agentId: id,
          name: 'AGENTS.md',
        });
        if (path.resolve(current.workspace) !== path.resolve(workspace))
          throw new Error('agentRuntimeUnknown');
        assertActive();
        await this.deps.requestGateway('agents.files.set', {
          agentId: id,
          name: 'AGENTS.md',
          content: input.instructions,
        });
        const verified = await this.deps.requestGateway<{ file?: { content?: string } }>(
          'agents.files.get',
          { agentId: id, name: 'AGENTS.md' },
        );
        if (verified.file?.content !== input.instructions) throw new Error('agentRuntimeUnknown');
        db.transaction(() => {
          store.saveAgentProfile({ ...profile, enabled: true });
          db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ?').run(
            JSON.stringify({ digest, stage: 'ready' }),
            Date.now(),
            RECORD_PREFIX + id,
          );
        })();
        try {
          this.deps.onChanged();
        } catch {
          /* A closed window cannot undo a native creation. */
        }
        return { status: 'created', agentId: id, name: input.name, enabled: true };
      } catch (error) {
        // Retain the stable identity for explicit retry, including an uncertain native RPC outcome.
        // A preparing profile stays disabled and cannot receive collaboration work.
        return {
          status: 'incomplete',
          agentId: id,
          name: input.name,
          error: error instanceof Error ? error.message : 'agentSaveFailed',
        };
      }
    });
  }
}
