import type { ToolItem } from '../../model/chat-transcript-state';
import {
  EDIT_NEW_TEXT_FIELDS,
  EDIT_OLD_TEXT_FIELDS,
  EDIT_PATH_FIELDS,
  type EditToolDiff,
  parseEditToolDiff,
} from '../../model/tools/edit-tool-diff';
import { fileToolCode, fileToolIdentity } from '../../model/tools/file-tool-presentation';
import { asToolRecord } from '../../model/tools/tool-message-adapter';
import { getCodeModeSource } from './code-mode-presentation';

const TOOL_INPUT_JSON_INDENT = '  ';

export type ToolInlinePreview =
  | { kind: 'edit'; diff: EditToolDiff; rawInputPath?: string[]; rawInputRoot?: 'args' }
  | { kind: 'exec'; command?: string; language: string; rawInputPath?: string[] }
  | { kind: 'write'; path?: string; text?: string; rawInputPath?: string[] };

export interface ToolInputMirrorRange {
  start: number;
  end: number;
}

/** Locate properties in toolInputText's pretty-printed JSON without decoding long strings. */
function toolInputProperty(text: string, path: string[]) {
  let start = 0;
  let end = text.length;
  let indentation = '';
  for (const parent of path.slice(0, -1)) {
    indentation += TOOL_INPUT_JSON_INDENT;
    const object = `\n${indentation}${JSON.stringify(parent)}: {`;
    const opening = text.indexOf(object, start);
    if (opening < 0 || opening >= end) return undefined;
    start = opening + object.length;
    const closing = text.indexOf(`\n${indentation}}`, start);
    if (closing < 0 || closing >= end) return undefined;
    end = closing;
  }
  indentation += TOOL_INPUT_JSON_INDENT;
  const field = `\n${indentation}${JSON.stringify(path[path.length - 1])}: `;
  const key = text.indexOf(field, start);
  if (key < 0 || key >= end) return undefined;
  return { key, valueStart: key + field.length, indentation };
}

export function toolInputMirrorRange(text: string, path: string[]): ToolInputMirrorRange | undefined {
  const property = toolInputProperty(text, path);
  if (!property || text[property.valueStart] !== '"') return undefined;
  const valueStart = property.valueStart + 1;
  const nextLine = text.indexOf('\n', valueStart);
  const quote = nextLine - (text[nextLine - 1] === ',' ? 2 : 1);
  return text[quote] === '"' ? { start: valueStart, end: quote } : undefined;
}

/** The diff already owns the replacement bodies, including its context budget. */
export function toolEditInputBodyRanges(text: string, root?: string): ToolInputMirrorRange[] {
  return [...EDIT_OLD_TEXT_FIELDS, ...EDIT_NEW_TEXT_FIELDS, 'edits'].flatMap(field => {
    const property = toolInputProperty(text, root ? [root, field] : [field]);
    if (!property) return [];
    const { key, valueStart, indentation } = property;
    const closing = `\n${indentation}]`;
    const end = text.startsWith('[\n', valueStart)
      ? text.indexOf(closing, valueStart) + closing.length
      : text.indexOf('\n', valueStart);
    return end > valueStart ? [{ start: key, end }] : [];
  });
}

export function projectToolInlinePreview(tool: ToolItem): ToolInlinePreview | null {
  const name = tool.name.toLowerCase();
  const envelope = asToolRecord(tool.input);
  const coreName = typeof envelope?.id === 'string'
    ? /^openclaw:core:(exec|edit|write)$/.exec(envelope.id)?.[1]
    : undefined;
  const wrapped = coreName !== undefined && (name === 'tool_call' || name === coreName);
  const nativeTool = wrapped ? { ...tool, name: coreName, input: envelope?.args } : tool;

  if (nativeTool.name.toLowerCase() === 'exec') {
    const rawPath = (field: string): string[] => wrapped ? ['args', field] : [field];
    const code = getCodeModeSource('exec', nativeTool.input);
    if (code !== null) return { kind: 'exec', command: code, language: 'javascript', rawInputPath: rawPath('code') };
    const args = asToolRecord(nativeTool.input);
    for (const field of ['command', 'cmd']) {
      const command = args?.[field];
      if (typeof command === 'string' && command.trim())
        return { kind: 'exec', command, language: '', rawInputPath: rawPath(field) };
    }
    return { kind: 'exec', language: '' };
  }

  const diff = parseEditToolDiff(nativeTool.name, nativeTool.input);
  if (diff) {
    const args = asToolRecord(nativeTool.input);
    const field = diff.path ? EDIT_PATH_FIELDS.find(key => typeof args?.[key] === 'string') : undefined;
    return {
      kind: 'edit', diff,
      rawInputPath: field ? (wrapped ? ['args', field] : [field]) : undefined,
      rawInputRoot: wrapped ? 'args' : undefined,
    };
  }
  if (fileToolIdentity(nativeTool).name !== 'write') return null;
  const file = fileToolCode(nativeTool, false);
  const nested = wrapped || nativeTool.name.toLowerCase() === 'tool_call';
  return {
    kind: 'write', text: file?.text, path: file?.path,
    rawInputPath: file ? (nested ? ['args', 'content'] : ['content']) : undefined,
  };
}

export function readableToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, TOOL_INPUT_JSON_INDENT) ?? String(value);
  } catch {
    return String(value);
  }
}

export function toolInputText(input: unknown): string | null {
  if (
    input === undefined ||
    input === null ||
    (typeof input === 'object' && Object.keys(input).length === 0)
  ) return null;
  return readableToolValue(input);
}

export function toolResultText(tool: ToolItem): string | undefined {
  if (tool.status === 'running' && tool.progressText) return tool.progressText;
  return tool.output ?? tool.error;
}
