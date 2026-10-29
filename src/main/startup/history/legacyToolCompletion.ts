import { createHash, randomUUID } from 'crypto';
import fs from 'fs';

type RecordValue = Record<string, unknown>;
type Row = { value: RecordValue; raw: string; index: number; changed: boolean };
type Call = { id: string; name: string; owner: Node; index: number };
type Node = {
  id: string;
  row: Row;
  parent: Node | null;
  visible: Node | null;
  pending: Call[];
  side: boolean;
  conversation: boolean;
  hasConversationChild: boolean;
};
const MISSING_TEXT = '[历史工具记录 / Historical tool record] 旧工具已结束，但原执行结果缺失或为空；此记录不证明执行成功。 / The historical tool has ended, but its original result is missing or empty. This record does not establish execution success.';
const SYNTHETIC_DETAIL_KEY = 'openclawSyntheticMissingToolResult';
const CANONICAL_TYPES = new Set(['message', 'thinking_level_change', 'model_change', 'compaction',
  'reset', 'branch_summary', 'custom', 'custom_message', 'label', 'session_info']);
const CALL_TYPES = new Set(['toolcall', 'tool_call', 'tooluse', 'tool_use', 'functioncall']);
const RESULT_TYPES = new Set(['toolresult', 'tool_result']);
const record = (value: unknown): RecordValue | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
function identity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value !== value.trim())
    throw new Error('Historical tool normalization refuses whitespace in native identities.');
  return value || undefined;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
const fail = (row: Row, reason: string): never => {
  throw new Error(`Historical tool normalization failed at line ${row.index + 1}: ${reason}.`);
};
function callId(source: RecordValue): string | undefined {
  const metadata = record(source.metadata);
  return [source.toolCallId, source.tool_call_id, source.toolUseId, source.tool_use_id,
    source.callId, source.id, metadata?.toolCallId, metadata?.tool_call_id,
    metadata?.toolUseId, metadata?.tool_use_id].map(identity).find(Boolean);
}
function toolName(source: RecordValue): string | undefined {
  const metadata = record(source.metadata);
  return [source.name, source.toolName, source.tool_name, metadata?.toolName, metadata?.tool_name]
    .map(text).find(Boolean);
}
function readable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.flatMap(part => {
      if (typeof part === 'string') return [part];
      const item = record(part);
      if (typeof item?.text === 'string') return [item.text];
      return item?.content !== undefined ? [readable(item.content)] : [];
    });
    if (parts.length) return parts.join('\n');
  }
  return value == null ? '' : JSON.stringify(value);
}
function normalizeEmptyResult(source: RecordValue, name: string): boolean {
  const phase = text(source.phase)?.toLowerCase();
  const status = text(source.status)?.toLowerCase();
  const legacyError = source.is_error === true && source.isError !== true;
  if (legacyError) source.isError = true;
  const error = source.error;
  const explicitError = error === true || (typeof error === 'string' && Boolean(error.trim())) ||
    (Boolean(error) && typeof error === 'object');
  if (source.isError === true || explicitError ||
    ['error', 'failed', 'timeout'].includes(status ?? '') ||
    ['cancel', 'cancelled', 'canceled', 'aborted'].includes(phase ?? status ?? '')) return legacyError;
  // The Renderer otherwise leaves an outputless Yield running even for phase:error.
  if (phase === 'error' || phase === 'failed' || phase === 'timeout') {
    source.isError = true;
    return true;
  }
  if (name.trim().toLowerCase() !== 'sessions_yield') return false;
  const metadata = record(source.metadata);
  const slots: Array<[RecordValue, string]> = ['result', 'partialResult', 'output', 'content', 'text', 'toolResult']
    .map(key => [source, key]);
  if (metadata) slots.push([metadata, 'toolResult']);
  const meaningful = (value: unknown) => {
    const output = readable(value).trim();
    return output !== '' && output !== '[]';
  };
  const first = slots.find(([owner, key]) => owner[key] != null);
  if (first && meaningful(first[0][first[1]])) return false;
  // Empty aliases can shadow a genuine later content/image result. Reveal it
  // rather than replacing it with a missing-result annotation.
  const actual = slots.find(([owner, key]) => owner[key] != null && meaningful(owner[key]));
  if (actual) {
    for (const [owner, key] of slots) {
      if (owner === actual[0] && key === actual[1]) break;
      if (owner[key] != null) delete owner[key];
    }
    return true;
  }
  for (const [owner, key] of slots) if (owner[key] != null) delete owner[key];
  source.content = [{ type: 'text', text: MISSING_TEXT }];
  source.isError = true;
  source.details = { ...record(source.details), [SYNTHETIC_DETAIL_KEY]: true, reason: 'missing_tool_result' };
  if (!toolName(source) || toolName(source) === 'tool') source.toolName = name;
  return true;
}
function signals(message: RecordValue, row: Row): Array<{ source: RecordValue; call: boolean; index: number }> {
  const role = text(message.role)?.toLowerCase();
  if (role === 'tooluse' || role === 'tool_use') return [{ source: message, call: true, index: 0 }];
  if (CALL_TYPES.has(role ?? ''))
    fail(row, 'standalone legacy tool roles are not supported');
  if (RESULT_TYPES.has(role ?? '') || role === 'tool' || role === 'function')
    return [{ source: message, call: false, index: 0 }];
  const content = Array.isArray(message.content) ? message.content : [];
  return content.flatMap((value, index) => {
    const source = record(value);
    const type = text(source?.type)?.toLowerCase();
    const call = CALL_TYPES.has(type ?? '') || Boolean(source && typeof source.name === 'string' &&
      [source.arguments, source.args, source.input, source.partialArgs].some(value => value !== undefined));
    return source && (call || RESULT_TYPES.has(type ?? ''))
      ? [{ source, call, index }] : [];
  });
}

/** Normalizes only a staged JSONL copy; unchanged input is returned byte-for-byte. */
export function normalizeLegacyToolHistoryContent(content: string): string {
  const lines = content.split('\n');
  const rows: Row[] = [];
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new Error(`Historical tool normalization failed at line ${index + 1}: invalid JSON.`);
    }
    const entry = record(value);
    if (entry) rows.push({ value: entry, raw, index, changed: false });
  }
  if (!rows.some(row => row.value.type === 'message' && signals(record(row.value.message) ?? {}, row).length))
    return content;
  const header = rows.find(row => row.value.type === 'session');
  if (!header || !identity(header.value.id)) throw new Error('Historical tool normalization requires a session header.');
  if (![2, 3, 4].includes(Number(header.value.version)))
    throw new Error('Historical tool normalization supports session versions 2, 3 and 4 only.');
  const nodes = new Map<string, Node>();
  const ids = new Set(rows.flatMap(row => identity(row.value.id) ? [identity(row.value.id)!] : []));
  const unresolved = new Map<Call, Node[]>();
  const resolved = new Map<Call, Node[]>();
  const after = new Map<Node, Call[]>();
  const before = new Map<Node, Call[]>();
  const selectedBefore = new Map<Node, Call[]>();
  const atEnd = new Set<Call>();
  const addPending = (pending: Call[], at: Node) => {
    for (const call of pending) {
      if (!unresolved.has(call)) unresolved.set(call, []);
      unresolved.get(call)!.push(at);
    }
  };
  let leaf: Node | null = null;
  let appendParent: string | null = null;
  let resetId: string | undefined;
  const resetDescendants = new Set<string>();
  for (const row of rows) {
    const entry = row.value;
    if (entry.type === 'session') continue;
    const canonical = CANONICAL_TYPES.has(String(entry.type));
    let id = identity(entry.id);
    if (!id) {
      if (!canonical || Object.hasOwn(entry, 'parentId')) fail(row, 'an indexed entry has no identity');
      id = `history-entry-${digest([header.value.id, row.index])}`;
      if (ids.has(id)) fail(row, 'generated entry identity collision');
      ids.add(id);
    }
    const previous = nodes.get(id);
    if (previous) {
      if (previous.row.raw !== row.raw) fail(row, 'conflicting duplicate entry identity');
      continue;
    }
    const reference = (value: unknown): Node | null => {
      if (value === null) return null;
      const target = identity(value);
      if (!target || !nodes.has(target)) fail(row, 'unknown or forward parent reference');
      return nodes.get(target)!;
    };
    let parent = Object.hasOwn(entry, 'parentId') ? reference(entry.parentId) : leaf;
    const side = entry.appendMode === 'side';
    if (canonical && !side && ((resetId && (!parent || !resetDescendants.has(parent.id))) ||
      (Object.hasOwn(entry, 'parentId') && entry.parentId === appendParent && leaf?.id !== appendParent)))
      parent = leaf;
    if (parent && !parent.visible) parent = parent.parent;
    const visibleParent = parent?.visible ?? null;
    const node: Node = { id, row, parent: visibleParent, visible: null,
      pending: visibleParent?.pending ?? [], side, conversation: false, hasConversationChild: false };
    if (entry.type === 'leaf') {
      let selected = reference(entry.targetId)?.visible ?? null;
      if (resetId && (!selected || !resetDescendants.has(selected.id))) selected = leaf;
      node.parent = selected;
      node.visible = selected;
      node.pending = selected?.pending ?? [];
      if (entry.appendParentId !== undefined) reference(entry.appendParentId);
      leaf = selected;
      appendParent = entry.appendParentId === undefined ? selected?.id ?? null : entry.appendParentId as string | null;
    } else {
      node.visible = canonical ? node : visibleParent;
      const message = entry.type === 'message' ? record(entry.message) : null;
      const toolSignals = message ? signals(message, row) : [];
      const frameCalls = new Set<string>();
      const role = text(message?.role)?.toLowerCase();
      node.conversation = Boolean(message && (!side || toolSignals.length));
      if (entry.type === 'reset' || entry.type === 'compaction' || role === 'user') {
        addPending(node.pending, node);
        node.pending = [];
      }
      if (toolSignals.length) node.pending = [...node.pending];
      for (const signal of toolSignals) {
        const toolId = callId(signal.source);
        if (signal.call) {
          if (!toolId) fail(row, 'a tool call has no exact identity');
          if (frameCalls.has(toolId)) fail(row, 'duplicate tool-call identity within one assistant frame');
          frameCalls.add(toolId);
          node.pending.push({ id: toolId, name: toolName(signal.source) ?? 'unknown', owner: node, index: signal.index });
          continue;
        }
        let candidates = node.pending.filter(call => toolId ? call.id === toolId :
          call.name === toolName(signal.source));
        const latestOwner = candidates.at(-1)?.owner;
        candidates = candidates.filter(call => call.owner === latestOwner);
        if (!toolId && candidates.length > 1) fail(row, 'a tool result has ambiguous ownership');
        const call = candidates[0];
        const resultName = toolName(signal.source);
        if (normalizeEmptyResult(signal.source, !resultName || resultName === 'tool'
          ? call?.name ?? 'unknown' : resultName)) row.changed = true;
        if (call) {
          node.pending.splice(node.pending.indexOf(call), 1);
          if (!resolved.has(call)) resolved.set(call, []);
          resolved.get(call)!.push(node);
        }
      }
      if (node.conversation) {
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent)
          if (ancestor.conversation) { ancestor.hasConversationChild = true; break; }
      }
      if (canonical && !side) leaf = node;
      appendParent = id;
    }
    nodes.set(id, node);
    if (entry.type === 'reset') { resetId = id; resetDescendants.clear(); resetDescendants.add(id); }
    else if (node.parent && resetDescendants.has(node.parent.id)) resetDescendants.add(id);
  }
  for (const node of nodes.values())
    if (node.conversation && !node.hasConversationChild)
      addPending(node.side ? node.pending.filter(call => call.owner.side) : node.pending, node);
  if (leaf) addPending(leaf.pending, leaf);
  for (const [call, endings] of unresolved) {
    const results = resolved.get(call) ?? [];
    if (!results.length) {
      if (!after.has(call.owner)) after.set(call.owner, []);
      after.get(call.owner)!.push(call);
      continue;
    }
    const covered = new Set<Node>();
    for (const result of results)
      for (let ancestor: Node | null = result; ancestor; ancestor = ancestor.parent) {
        covered.add(ancestor);
        if (ancestor === call.owner) break;
      }
    for (const ending of endings) {
      const path: Node[] = [];
      for (let cursor: Node | null = ending; cursor && cursor !== call.owner; cursor = cursor.parent)
        path.push(cursor);
      const edge = path.reverse().find(node => !covered.has(node));
      if (!edge) {
        const selection = [...nodes.values()].reverse().find(node =>
          node.row.value.type === 'leaf' && node.visible === ending && leaf === ending);
        if (!selection) {
          if (ending !== leaf) fail(ending.row, 'the selected ancestor has no safe missing-result branch edge');
          // Side results do not advance the visible leaf. Close its own path
          // after the original side records, preserving their genuine results.
          atEnd.add(call);
          continue;
        }
        if (!selectedBefore.has(selection)) selectedBefore.set(selection, []);
        if (!selectedBefore.get(selection)!.includes(call)) selectedBefore.get(selection)!.push(call);
        continue;
      }
      if (!before.has(edge)) before.set(edge, []);
      if (!before.get(edge)!.includes(call)) before.get(edge)!.push(call);
    }
  }
  if (!after.size && !before.size && !selectedBefore.size && !atEnd.size && !rows.some(row => row.changed)) return content;
  for (const row of rows)
    if (row.value.type === 'compaction' && row.value.firstKeptEntryIndex !== undefined)
      fail(row, 'index-based legacy compaction is not supported');
  const rowByIndex = new Map(rows.map(row => [row.index, row]));
  const additions = new Map<number, string[]>();
  const replacements = new Map<string, string>();
  const beforeParents = new Map<Node, string>();
  const selectedLeaves = new Map<Node, string>();
  const appendResults = (
    anchor: Node, calls: Call[], preceding: string | null, beforeNode: boolean, side = anchor.side,
  ) => {
    const resultLines: string[] = [];
    for (const call of [...calls].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))) {
      const id = `history-tool-result-${digest([header.value.id, call.owner.id, call.index, call.id,
        beforeNode ? anchor.id : null])}`;
      if (ids.has(id)) fail(anchor.row, 'generated tool-result identity collision');
      ids.add(id);
      const result: RecordValue = {
        type: 'message', id, parentId: preceding,
        ...(typeof call.owner.row.value.timestamp === 'string' ? { timestamp: call.owner.row.value.timestamp } : {}),
        ...(side ? { appendMode: 'side' } : {}),
        message: { role: 'toolResult', toolCallId: call.id, toolName: call.name,
          content: [{ type: 'text', text: MISSING_TEXT }], isError: true,
          details: { [SYNTHETIC_DETAIL_KEY]: true, reason: 'missing_tool_result' } },
      };
      resultLines.push(JSON.stringify(result));
      preceding = id;
    }
    const slot = beforeNode ? anchor.row.index * 2 : anchor.row.index * 2 + 1;
    additions.set(slot, [...additions.get(slot) ?? [], ...resultLines]);
    return preceding!;
  };
  for (const [node, calls] of after) replacements.set(node.id, appendResults(node, calls, node.id, false));
  for (const [node, calls] of before) {
    const parent = Object.hasOwn(node.row.value, 'parentId') ? node.row.value.parentId as string | null : node.parent?.id ?? null;
    const preceding = typeof parent === 'string' ? replacements.get(parent) ?? parent : parent;
    beforeParents.set(node, appendResults(node, calls, preceding, true));
  }
  for (const [node, calls] of selectedBefore)
    selectedLeaves.set(node, appendResults(node, calls, node.visible?.id ?? null, true));
  if (atEnd.size && leaf) {
    const anchor = [...nodes.values()].at(-1)!;
    appendResults(anchor, [...atEnd], replacements.get(leaf.id) ?? leaf.id, false, false);
  }
  const output: string[] = [];
  for (const [index, raw] of lines.entries()) {
    output.push(...additions.get(index * 2) ?? []);
    const row = rowByIndex.get(index);
    if (row && row.value.type !== 'session') {
      const id = identity(row.value.id) ?? `history-entry-${digest([header.value.id, row.index])}`;
      const node = nodes.get(id);
      if (!identity(row.value.id)) { row.value.id = id; row.changed = true; }
      const rewrite = (key: string) => {
        const value = row.value[key];
        const replacement = typeof value === 'string' ? replacements.get(value) : undefined;
        if (replacement) { row.value[key] = replacement; row.changed = true; }
      };
      rewrite('parentId');
      if (row.value.type === 'leaf') { rewrite('targetId'); rewrite('appendParentId'); }
      if (node && beforeParents.has(node)) { row.value.parentId = beforeParents.get(node); row.changed = true; }
      if (node && selectedLeaves.has(node)) {
        row.value.targetId = selectedLeaves.get(node);
        if (row.value.appendParentId === node.visible?.id) row.value.appendParentId = selectedLeaves.get(node);
        row.changed = true;
      }
    }
    output.push(row?.changed ? JSON.stringify(row.value) : raw);
    output.push(...additions.get(index * 2 + 1) ?? []);
  }
  const normalized = output.join('\n');
  return normalized.endsWith('\n') ? normalized : normalized + '\n';
}

export function normalizeLegacyToolHistory(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid staged historical transcript.');
  const original = fs.readFileSync(file, 'utf8');
  const normalized = normalizeLegacyToolHistoryContent(original);
  if (normalized === original) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', stat.mode & 0o777);
    try { fs.writeFileSync(descriptor, normalized, 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
