import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import {
  SkillWorkshopAction,
  SkillWorkshopActor,
  type SkillWorkshopArchiveInput,
  type SkillWorkshopChange,
  type SkillWorkshopChangesInput,
  type SkillWorkshopFile,
  type SkillWorkshopInventory,
  type SkillWorkshopReadInput,
  type SkillWorkshopRestoreInput,
} from '../../../shared/plugins/skillWorkshop';

type Request = <T>(method: string, params?: unknown) => Promise<T>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => timestamp(value) && Number.isInteger(value);
const files = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const action = (value: unknown) =>
  Object.values(SkillWorkshopAction).includes(value as SkillWorkshopAction);
const assertResponse: (condition: unknown) => asserts condition = condition => {
  if (!condition) throw new Error('skillWorkshopInvalidResponse');
};
function isChange(value: unknown): value is SkillWorkshopChange {
  return (
    object(value) &&
    text(value.id) &&
    text(value.agentId) &&
    text(value.skillName) &&
    action(value.action) &&
    Object.values(SkillWorkshopActor).includes(value.actor as SkillWorkshopActor) &&
    typeof value.summary === 'string' &&
    timestamp(value.createdAtMs) &&
    ['versionId', 'sessionKey', 'runId'].every(key => value[key] === undefined || text(value[key]))
  );
}

/** Native Workshop owns files, saved versions and the change feed. No local ledger or retries. */
export class SkillWorkshopService {
  private readonly mutations = new Set<string>();
  constructor(private readonly request: Request) {}

  private checkAgent(agentId: unknown): void {
    if (agentId !== MAIN_USER_AGENT_ID) throw new Error('skillWorkshopMainOnly');
  }
  private checkName(name: unknown): asserts name is string {
    // Native existing-name rules include legacy names longer than 63 characters.
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,254}$/.test(name))
      throw new Error('skillWorkshopInvalidInput');
  }
  private checkVersion(versionId: unknown): asserts versionId is string {
    if (!text(versionId) || versionId.length > 256 || /[\\/\0]/.test(versionId))
      throw new Error('skillWorkshopInvalidInput');
  }

  async list(agentId: string): Promise<SkillWorkshopInventory> {
    this.checkAgent(agentId);
    const result = await this.request<unknown>('skills.workshop.list', { agentId });
    assertResponse(
      object(result) &&
        result.agentId === agentId &&
        ['off', 'auto'].includes(result.mode as string) &&
        text(result.root) &&
        Array.isArray(result.skills) &&
        result.skills.every(
          skill =>
            object(skill) &&
            text(skill.name) &&
            typeof skill.description === 'string' &&
            timestamp(skill.updatedAtMs) &&
            count(skill.sizeBytes) &&
            files(skill.files) &&
            (skill.useCount === undefined || count(skill.useCount)) &&
            (skill.lastUsedAtMs === undefined || timestamp(skill.lastUsedAtMs)),
        ) &&
        Array.isArray(result.archived) &&
        result.archived.every(
          skill =>
            object(skill) &&
            text(skill.name) &&
            typeof skill.live === 'boolean' &&
            Array.isArray(skill.versions) &&
            skill.versions.every(
              version =>
                object(version) &&
                text(version.id) &&
                action(version.action) &&
                timestamp(version.createdAtMs),
            ),
        ),
    );
    return result as unknown as SkillWorkshopInventory;
  }

  async changes(input: SkillWorkshopChangesInput): Promise<SkillWorkshopChange[]> {
    this.checkAgent(input?.agentId);
    if (
      (input.limit !== undefined &&
        (!count(input.limit) || input.limit < 1 || input.limit > 500)) ||
      (input.beforeMs !== undefined && !timestamp(input.beforeMs))
    )
      throw new Error('skillWorkshopInvalidInput');
    const result = await this.request<unknown>('skills.workshop.changes', {
      agentId: input.agentId,
      limit: input.limit ?? 200,
      ...(input.beforeMs !== undefined ? { beforeMs: input.beforeMs } : {}),
    });
    assertResponse(
      object(result) &&
        Array.isArray(result.changes) &&
        result.changes.every(change => isChange(change) && change.agentId === input.agentId),
    );
    return result.changes as SkillWorkshopChange[];
  }

  async read(input: SkillWorkshopReadInput): Promise<SkillWorkshopFile> {
    this.checkAgent(input?.agentId);
    this.checkName(input?.name);
    if (input.versionId !== undefined) this.checkVersion(input.versionId);
    const filePath = input.filePath ?? 'SKILL.md';
    if (
      !text(filePath) ||
      filePath.length > 1024 ||
      /[\\\0]/.test(filePath) ||
      filePath.split('/').some(part => !part || part === '..' || part === '.') ||
      filePath.includes(':')
    )
      throw new Error('skillWorkshopInvalidInput');
    const result = await this.request<unknown>('skills.workshop.read', {
      agentId: input.agentId,
      name: input.name,
      filePath,
      ...(input.versionId !== undefined ? { versionId: input.versionId } : {}),
    });
    assertResponse(
      object(result) &&
        result.name === input.name &&
        result.filePath === filePath &&
        typeof result.content === 'string' &&
        files(result.files) &&
        result.files.includes(filePath),
    );
    return result as unknown as SkillWorkshopFile;
  }

  async archive(input: SkillWorkshopArchiveInput): Promise<SkillWorkshopChange> {
    this.checkAgent(input?.agentId);
    this.checkName(input?.name);
    if (input.reason !== undefined && (!text(input.reason) || input.reason.length > 1000))
      throw new Error('skillWorkshopInvalidInput');
    return this.mutate('archive', {
      agentId: input.agentId,
      name: input.name,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  }

  async restore(input: SkillWorkshopRestoreInput): Promise<SkillWorkshopChange> {
    this.checkAgent(input?.agentId);
    this.checkName(input?.name);
    this.checkVersion(input?.versionId);
    return this.mutate('restore', {
      agentId: input.agentId,
      name: input.name,
      versionId: input.versionId,
    });
  }

  private async mutate(
    kind: 'archive' | 'restore',
    input: SkillWorkshopArchiveInput | SkillWorkshopRestoreInput,
  ): Promise<SkillWorkshopChange> {
    const key = input.agentId + ':' + input.name;
    if (this.mutations.has(key)) throw new Error('skillWorkshopBusy');
    this.mutations.add(key);
    try {
      const result = await this.request<unknown>('skills.workshop.' + kind, input);
      assertResponse(
        object(result) &&
          isChange(result.change) &&
          result.change.agentId === input.agentId &&
          result.change.skillName === input.name &&
          result.change.action === kind &&
          result.change.actor === 'user',
      );
      return result.change;
    } catch (error) {
      // A missing/malformed reply can follow committed effects. Never replay or compensate.
      const code = object(error) ? error.gatewayCode : undefined;
      throw new Error(
        code === 'FORBIDDEN' ? 'skillWorkshopChangeRejected' : 'skillWorkshopMutationUnconfirmed',
        { cause: error },
      );
    } finally {
      this.mutations.delete(key);
    }
  }
}
