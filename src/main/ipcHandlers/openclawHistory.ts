import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import { OpenClawHistoryIpc } from '../../shared/openclawHistoryIpc';

export type OpenClawToolInputLookup = Record<string, { name?: string; input: unknown }>;

const coerceToolInput = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const hasToolInput = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() !== '{}';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
};

const resolveToolInput = (record: Record<string, unknown>): unknown => {
  for (const value of [record.arguments, record.args, record.input, record.toolInput]) {
    const coerced = coerceToolInput(value);
    if (hasToolInput(coerced)) return coerced;
  }
  return coerceToolInput(record.partialArgs);
};

export const collectToolInputsFromValue = (
  value: unknown,
  targetIds: Set<string>,
  found: OpenClawToolInputLookup,
  depth = 0,
): void => {
  if (depth > 8 || targetIds.size === Object.keys(found).length) return;
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolInputsFromValue(item, targetIds, found, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  const id = [
    record.id,
    record.toolCallId,
    record.tool_call_id,
    record.toolUseId,
    record.tool_use_id,
  ].find(item => typeof item === 'string' && targetIds.has(item)) as string | undefined;
  const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
  if (
    id &&
    !found[id] &&
    ['toolcall', 'tool_call', 'tooluse', 'tool_use', 'functioncall', 'function_call'].includes(type)
  ) {
    const input = resolveToolInput(record);
    if (hasToolInput(input)) {
      found[id] = {
        name: typeof record.name === 'string' ? record.name : undefined,
        input,
      };
    }
  }

  for (const key of ['message', 'data', 'messages', 'content']) {
    collectToolInputsFromValue(record[key], targetIds, found, depth + 1);
  }
};

const collectSessionJsonlFiles = (rootDir: string): string[] => {
  const files: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  return files;
};

export const registerOpenClawHistoryHandlers = (getStateDir: () => string): void => {
  ipcMain.handle(
    OpenClawHistoryIpc.GetToolInputs,
    async (
      _event,
      params: { sessionKey?: unknown; toolCallIds?: unknown },
    ): Promise<{ success: boolean; inputs?: OpenClawToolInputLookup; error?: string }> => {
      try {
        const toolCallIds = Array.isArray(params?.toolCallIds)
          ? params.toolCallIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
        if (toolCallIds.length === 0) return { success: true, inputs: {} };

        const targetIds = new Set(toolCallIds);
        const found: OpenClawToolInputLookup = {};
        const sessionFiles = collectSessionJsonlFiles(path.join(getStateDir(), 'agents'));

        for (const filePath of sessionFiles) {
          if (Object.keys(found).length >= targetIds.size) break;
          let text: string;
          try {
            text = fs.readFileSync(filePath, 'utf-8');
          } catch {
            continue;
          }
          if (!toolCallIds.some(id => text.includes(id))) continue;
          for (const line of text.split(/\r?\n/)) {
            if (!line.trim() || !toolCallIds.some(id => line.includes(id))) continue;
            try {
              collectToolInputsFromValue(JSON.parse(line), targetIds, found);
            } catch {
              continue;
            }
          }
        }
        return { success: true, inputs: found };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[OpenClawHistory] failed to hydrate tool inputs:', message);
        return { success: false, error: message };
      }
    },
  );
};
