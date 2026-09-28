import type { ToolItem } from './chat-transcript-state';
import { asToolRecord } from './tool-message-adapter';

export function fileToolIdentity(tool: ToolItem): { name: string; args: Record<string, unknown> } {
  const args = asToolRecord(tool.input) ?? {};
  const name = tool.name.toLowerCase();
  if (name === 'tool_call' && typeof args.id === 'string') {
    const target = args.id.replace(/^openclaw:core:/, '');
    if (['read', 'write', 'apply_patch'].includes(target))
      return { name: target, args: asToolRecord(args.args) ?? {} };
  }
  return { name, args };
}

export function fileToolCode(
  tool: ToolItem,
  result: boolean,
): { path: string; text: string } | null {
  const { name, args } = fileToolIdentity(tool);
  if (typeof args.path !== 'string') return null;
  if (!result && name === 'write' && typeof args.content === 'string')
    return { path: args.path, text: args.content };
  if (
    !result ||
    name !== 'read' ||
    tool.status !== 'completed' ||
    tool.error ||
    tool.output === undefined
  )
    return null;
  const read = tool.presentation?.fileRead;
  if (read && !['text', 'truncated'].includes(read.kind)) return null;
  return { path: args.path, text: tool.output };
}

export type PatchFile = {
  path: string;
  operation: 'Add' | 'Update' | 'Delete';
  moveTo?: string;
  text: string;
};
/** Show the submitted patch, never reconstruct a file version from incomplete hunks. */
export function fileToolPatch(tool: ToolItem): PatchFile[] {
  const { name, args } = fileToolIdentity(tool);
  const input = typeof tool.input === 'string' ? tool.input : args.input;
  if (name !== 'apply_patch' || typeof input !== 'string' || input.length > 120_000) return [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  if (lines.shift() !== '*** Begin Patch') return [];
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.pop() !== '*** End Patch') return [];
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const line of lines) {
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (match) {
      current = { operation: match[1] as PatchFile['operation'], path: match[2], text: '' };
      files.push(current);
    } else if (current && line.startsWith('*** Move to: ')) current.moveTo = line.slice(13);
    else if (current && (/^[ +\-@]/.test(line) || line === '*** End of File' || line === ''))
      current.text += line + '\n';
    else return [];
  }
  return files.length <= 100 ? files : [];
}
