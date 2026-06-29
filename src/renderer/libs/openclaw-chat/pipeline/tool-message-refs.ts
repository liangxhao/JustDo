import { normalizeOptionalString } from '../shims/normalization-core';
import { isToolCallContentType, isToolResultContentType, resolveToolUseId } from '../shims/backend-helpers';
import { normalizeRoleForGrouping } from './role-normalizer';

const TOOL_NAME_FIELDS = ['toolName', 'tool_name'] as const;

export type ToolMessageRef = {
  id: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function addToolRef(refs: ToolMessageRef[], seen: Set<string>, id: string | undefined) {
  if (!id || seen.has(id)) {
    return;
  }
  seen.add(id);
  refs.push({ id });
}

function isToolLikeRole(role: unknown): boolean {
  return typeof role === 'string' && normalizeRoleForGrouping(role).toLowerCase() === 'tool';
}

function hasToolName(message: Record<string, unknown>): boolean {
  return TOOL_NAME_FIELDS.some((field) => Boolean(normalizeOptionalString(message[field])));
}

function toolContentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter(
        (block: unknown): block is Record<string, unknown> => Boolean(block) && typeof block === 'object',
      )
    : [];
}

function isToolContentBlock(block: Record<string, unknown>): boolean {
  return isToolCallContentType(block.type) || isToolResultContentType(block.type);
}

export function extractToolMessageRefs(message: unknown): ToolMessageRef[] {
  const record = asRecord(message);
  if (!record) {
    return [];
  }

  const refs: ToolMessageRef[] = [];
  const seen = new Set<string>();
  const blocks = toolContentBlocks(record);
  const hasToolBlock = blocks.some(isToolContentBlock);
  const topLevelToolId = resolveToolUseId(record);
  const messageHasToolShape = isToolLikeRole(record.role) || hasToolName(record) || hasToolBlock;

  if (messageHasToolShape) {
    addToolRef(refs, seen, topLevelToolId);
  }

  for (const block of blocks) {
    if (!isToolContentBlock(block)) {
      continue;
    }
    addToolRef(refs, seen, resolveToolUseId(block) ?? topLevelToolId);
  }

  return refs;
}
