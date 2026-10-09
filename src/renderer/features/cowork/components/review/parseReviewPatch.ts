export interface ReviewLine {
  kind: 'context' | 'added' | 'deleted' | 'hunk' | 'note';
  text: string;
  omitted?: number;
  oldLine?: number;
  newLine?: number;
}
export function parseReviewPatch(
  patch: string,
  limit = 2000,
): { lines: ReviewLine[]; truncated: boolean } {
  const lines: ReviewLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const source = patch.split('\n');
  for (const raw of source) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    const isDisplayLine = hunk || (inHunk && /^[+\- \\]/.test(raw));
    if (isDisplayLine && lines.length >= limit) return { lines, truncated: true };
    if (hunk) {
      const omitted = Math.max(
        0,
        Number(hunk[1]) - (inHunk ? oldLine : 1),
        Number(hunk[2]) - (inHunk ? newLine : 1),
      );
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw, omitted });
    } else if (inHunk && raw.startsWith('+')) {
      lines.push({ kind: 'added', text: raw.slice(1), newLine: newLine++ });
    } else if (inHunk && raw.startsWith('-')) {
      lines.push({ kind: 'deleted', text: raw.slice(1), oldLine: oldLine++ });
    } else if (inHunk && raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (inHunk && raw.startsWith('\\')) {
      lines.push({ kind: 'note', text: raw });
    }
  }
  return { lines, truncated: false };
}
export function splitReviewLines(
  lines: ReviewLine[],
): { left?: ReviewLine; right?: ReviewLine; header?: ReviewLine }[] {
  const rows: ReturnType<typeof splitReviewLines> = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === 'hunk' || line.kind === 'note') {
      rows.push({ header: line });
      index++;
    } else if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      index++;
    } else {
      const removed: ReviewLine[] = [];
      const added: ReviewLine[] = [];
      while (lines[index]?.kind === 'deleted') removed.push(lines[index++]);
      while (lines[index]?.kind === 'added') added.push(lines[index++]);
      for (let row = 0; row < Math.max(removed.length, added.length); row++)
        rows.push({ left: removed[row], right: added[row] });
    }
  }
  return rows;
}
