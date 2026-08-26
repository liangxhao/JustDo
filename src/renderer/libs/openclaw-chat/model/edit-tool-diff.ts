export type EditToolReplacement = {
  oldText: string;
  newText: string;
};

export type EditToolDiff = {
  path: string | null;
  edits: EditToolReplacement[];
};

export type EditDiffLine = {
  kind: 'context' | 'removed' | 'added' | 'omitted';
  text: string;
};

export type EditDiffHunk = {
  lines: EditDiffLine[];
  addedCount: number;
  removedCount: number;
  truncated: boolean;
};

export type EditDiffViewHunk = EditDiffHunk & {
  editIndex: number;
};

export type EditDiffView = {
  hunks: EditDiffViewHunk[];
  totalEditCount: number;
  omittedEditCount: number;
  addedCount: number;
  removedCount: number;
};

export type EditSplitDiffRow = {
  before: EditDiffLine | null;
  after: EditDiffLine | null;
};

const MAX_LCS_CELLS = 200_000;
const MAX_RENDERED_DIFF_LINES = 600;
const MAX_RENDERED_DIFF_HUNKS = 40;
const DIFF_CONTEXT_LINES = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function parseEdits(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseReplacement(value: unknown): EditToolReplacement | null {
  const record = asRecord(value);
  if (!record) return null;
  const oldText = readString(record, ['oldText', 'old_string']);
  const newText = readString(record, ['newText', 'new_string']);
  return oldText !== null && newText !== null ? { oldText, newText } : null;
}

function isEditToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[\s_-]+/g, '');
  return normalized === 'edit' || normalized === 'editfile' || normalized === 'multiedit';
}

export function parseEditToolDiff(toolName: string, input: unknown): EditToolDiff | null {
  if (!isEditToolName(toolName)) return null;
  const record = asRecord(input);
  if (!record) return null;

  const edits: EditToolReplacement[] = [];
  if (record.edits !== undefined) {
    const declaredEdits = parseEdits(record.edits);
    if (!declaredEdits) return null;
    const parsedEdits = declaredEdits.map(parseReplacement);
    if (parsedEdits.some(edit => edit === null)) return null;
    edits.push(...(parsedEdits as EditToolReplacement[]));
  }

  const declaresLegacyEdit = ['oldText', 'old_string', 'newText', 'new_string'].some(
    key => record[key] !== undefined,
  );
  const legacyEdit = parseReplacement(record);
  if (declaresLegacyEdit && !legacyEdit) return null;
  if (legacyEdit) edits.push(legacyEdit);
  if (edits.length === 0) return null;

  const rawPath = readString(record, ['path', 'file_path', 'filePath', 'file']);
  return {
    path: rawPath?.trim() || null,
    edits,
  };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function buildMiddleDiff(oldLines: string[], newLines: string[]): EditDiffLine[] {
  if (oldLines.length === 0) return newLines.map(text => ({ kind: 'added', text }));
  if (newLines.length === 0) return oldLines.map(text => ({ kind: 'removed', text }));
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return [
      ...oldLines.map(text => ({ kind: 'removed' as const, text })),
      ...newLines.map(text => ({ kind: 'added' as const, text })),
    ];
  }

  const width = newLines.length + 1;
  const lcs = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      lcs[offset] =
        oldLines[oldIndex] === newLines[newIndex]
          ? lcs[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(lcs[(oldIndex + 1) * width + newIndex], lcs[offset + 1]);
    }
  }

  const lines: EditDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: 'context', text: oldLines[oldIndex] ?? '' });
      oldIndex += 1;
      newIndex += 1;
    } else if (lcs[(oldIndex + 1) * width + newIndex] >= lcs[oldIndex * width + newIndex + 1]) {
      lines.push({ kind: 'removed', text: oldLines[oldIndex] ?? '' });
      oldIndex += 1;
    } else {
      lines.push({ kind: 'added', text: newLines[newIndex] ?? '' });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    lines.push({ kind: 'removed', text: oldLines[oldIndex] ?? '' });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    lines.push({ kind: 'added', text: newLines[newIndex] ?? '' });
    newIndex += 1;
  }
  return lines;
}

function collapseContextRuns(lines: EditDiffLine[]): EditDiffLine[] {
  const collapsed: EditDiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.kind !== 'context') {
      const line = lines[index];
      if (line) collapsed.push(line);
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < lines.length && lines[index]?.kind === 'context') index += 1;
    const run = lines.slice(runStart, index);
    const hasChangeBefore = runStart > 0;
    const hasChangeAfter = index < lines.length;
    const headCount = hasChangeBefore ? DIFF_CONTEXT_LINES : 0;
    const tailCount = hasChangeAfter ? DIFF_CONTEXT_LINES : 0;
    if (run.length <= headCount + tailCount) {
      collapsed.push(...run);
      continue;
    }
    if (headCount > 0) collapsed.push(...run.slice(0, headCount));
    collapsed.push({ kind: 'omitted', text: '' });
    if (tailCount > 0) collapsed.push(...run.slice(-tailCount));
  }
  return collapsed;
}

function boundDiffLines(lines: EditDiffLine[], maxLines: number): EditDiffLine[] {
  if (maxLines <= 0) return [];
  if (lines.length <= maxLines) return lines;
  if (maxLines === 1) return [{ kind: 'omitted', text: '' }];
  const availableLines = maxLines - 1;
  const headCount = Math.ceil(availableLines / 2);
  const tailCount = availableLines - headCount;
  return [
    ...lines.slice(0, headCount),
    { kind: 'omitted', text: '' },
    ...(tailCount > 0 ? lines.slice(-tailCount) : []),
  ];
}

function buildFullEditDiffHunk(edit: EditToolReplacement): Omit<EditDiffHunk, 'truncated'> {
  const oldLines = splitLines(edit.oldText);
  const newLines = splitLines(edit.newText);
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - suffixLength - 1] === newLines[newLines.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const prefix = oldLines.slice(0, prefixLength).map(text => ({ kind: 'context' as const, text }));
  const oldMiddleEnd = suffixLength > 0 ? oldLines.length - suffixLength : oldLines.length;
  const newMiddleEnd = suffixLength > 0 ? newLines.length - suffixLength : newLines.length;
  const middle = buildMiddleDiff(
    oldLines.slice(prefixLength, oldMiddleEnd),
    newLines.slice(prefixLength, newMiddleEnd),
  );
  const suffix =
    suffixLength > 0
      ? oldLines.slice(oldLines.length - suffixLength).map(text => ({
          kind: 'context' as const,
          text,
        }))
      : [];
  const fullLines = [...prefix, ...middle, ...suffix];
  const addedCount = fullLines.filter(line => line.kind === 'added').length;
  const removedCount = fullLines.filter(line => line.kind === 'removed').length;
  return { lines: fullLines, addedCount, removedCount };
}

export function buildEditDiffHunk(
  edit: EditToolReplacement,
  maxLines = MAX_RENDERED_DIFF_LINES,
): EditDiffHunk {
  const fullHunk = buildFullEditDiffHunk(edit);
  const contextCollapsedLines = collapseContextRuns(fullHunk.lines);
  const lines = boundDiffLines(contextCollapsedLines, maxLines);
  const truncated =
    contextCollapsedLines.length !== fullHunk.lines.length ||
    lines.length !== contextCollapsedLines.length;

  return { ...fullHunk, lines, truncated };
}

function renderedEditIndexes(editCount: number): Set<number> {
  if (editCount <= MAX_RENDERED_DIFF_HUNKS) {
    return new Set(Array.from({ length: editCount }, (_, index) => index));
  }
  const headCount = Math.ceil(MAX_RENDERED_DIFF_HUNKS * 0.75);
  const tailCount = MAX_RENDERED_DIFF_HUNKS - headCount;
  return new Set([
    ...Array.from({ length: headCount }, (_, index) => index),
    ...Array.from({ length: tailCount }, (_, index) => editCount - tailCount + index),
  ]);
}

export function buildEditDiffView(diff: EditToolDiff): EditDiffView {
  const visibleIndexes = renderedEditIndexes(diff.edits.length);
  const perHunkLineBudget = Math.max(
    1,
    Math.floor(MAX_RENDERED_DIFF_LINES / Math.max(visibleIndexes.size, 1)),
  );
  const hunks: EditDiffViewHunk[] = [];
  let addedCount = 0;
  let removedCount = 0;

  diff.edits.forEach((edit, editIndex) => {
    const fullHunk = buildFullEditDiffHunk(edit);
    addedCount += fullHunk.addedCount;
    removedCount += fullHunk.removedCount;
    if (!visibleIndexes.has(editIndex)) return;
    const contextCollapsedLines = collapseContextRuns(fullHunk.lines);
    const lines = boundDiffLines(contextCollapsedLines, perHunkLineBudget);
    hunks.push({
      ...fullHunk,
      editIndex,
      lines,
      truncated:
        contextCollapsedLines.length !== fullHunk.lines.length ||
        lines.length !== contextCollapsedLines.length,
    });
  });

  return {
    hunks,
    totalEditCount: diff.edits.length,
    omittedEditCount: diff.edits.length - hunks.length,
    addedCount,
    removedCount,
  };
}

export function buildEditSplitDiffRows(lines: EditDiffLine[]): EditSplitDiffRow[] {
  const rows: EditSplitDiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line) break;
    if (line.kind === 'context' || line.kind === 'omitted') {
      rows.push({ before: line, after: line });
      index += 1;
      continue;
    }

    const removed: EditDiffLine[] = [];
    const added: EditDiffLine[] = [];
    while (index < lines.length) {
      const change = lines[index];
      if (!change || change.kind === 'context' || change.kind === 'omitted') break;
      if (change.kind === 'removed') removed.push(change);
      if (change.kind === 'added') added.push(change);
      index += 1;
    }
    const rowCount = Math.max(removed.length, added.length);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      rows.push({ before: removed[rowIndex] ?? null, after: added[rowIndex] ?? null });
    }
  }
  return rows;
}
