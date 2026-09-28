/** A bounded syntax tree of source ranges: duplicate keys and number spelling survive. */
export interface JsonSourceNode {
  label: string;
  start: number;
  end: number;
  children?: JsonSourceNode[];
}
export function parseJsonSource(source: string): JsonSourceNode | null {
  if (source.length > 40_000 || !/^[ \t\r\n]*[\[{]/.test(source)) return null;
  let cursor = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(source[cursor] ?? '') && cursor < source.length) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor++] === '"') {
        JSON.parse(source.slice(start, cursor));
        return;
      }
    }
    throw new Error('string');
  };
  const value = (label: string, depth: number): JsonSourceNode => {
    if (++nodes > 3000 || depth > 40) throw new Error('complexity');
    whitespace();
    const start = cursor;
    const open = source[cursor];
    if (open === '{' || open === '[') {
      cursor++;
      whitespace();
      const close = open === '{' ? '}' : ']';
      const children: JsonSourceNode[] = [];
      if (source[cursor] !== close)
        for (;;) {
          whitespace();
          let childLabel = String(children.length);
          if (open === '{') {
            if (source[cursor] !== '"') throw new Error('key');
            const keyStart = cursor;
            string();
            childLabel = source.slice(keyStart, cursor);
            whitespace();
            if (source[cursor++] !== ':') throw new Error('colon');
          }
          children.push(value(childLabel, depth + 1));
          whitespace();
          if (source[cursor] === close) break;
          if (source[cursor++] !== ',') throw new Error('comma');
        }
      if (source[cursor++] !== close) throw new Error('close');
      return { label, start, end: cursor, children };
    }
    if (open === '"') string();
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        source.slice(cursor),
      );
      if (!match) throw new Error('value');
      cursor += match[0].length;
    }
    return { label, start, end: cursor };
  };
  try {
    const tree = value('', 0);
    whitespace();
    return cursor === source.length ? tree : null;
  } catch {
    return null;
  }
}
export function tableToTsv(table: HTMLTableElement): string {
  // Quote cells containing tabs/newlines/quotes, doubling embedded quotes (spreadsheet convention).
  return Array.from(table.rows, row =>
    Array.from(row.cells, cell => {
      const value = cell.textContent ?? '';
      return /[\t\r\n"]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
    }).join('\t'),
  ).join('\n');
}
