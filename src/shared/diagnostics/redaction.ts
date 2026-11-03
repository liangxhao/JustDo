const secretKey = (key: string) =>
  /(?:password|passwd|token|secret|apikey|accesskey|privatekey|authorization|cookie|credentials?|accesscode)$/i.test(
    key.replace(/[-_\s]/g, ''),
  );

function redactQuotedCredentials(value: string): string {
  const prefix = /(?<![\w-])((?:"([\w \t-]+)"|'([\w \t-]+)'|([\w-]+))[ \t]*[:=][ \t]*|--([\w-]+)[ \t]+)(["'])/g;
  let result = '';
  let copiedThrough = 0;
  for (let match = prefix.exec(value); match; match = prefix.exec(value)) {
    const key = (match[2] ?? match[3] ?? match[4] ?? match[5]).replace(/[-_\s]/g, '');
    if (!/(?:password|passwd|token|secret|apikey|accesskey|privatekey|authorization|cookie|credential|accesscode)/i.test(key)) {
      prefix.lastIndex--;
      continue;
    }
    const quote = match[6];
    let end = prefix.lastIndex;
    while (end < value.length) {
      if (value[end] === quote) break;
      if (value[end] === '\\' && end + 1 < value.length) end++;
      end++;
    }
    // Prefer confidentiality if the quoted value has no unambiguous closing delimiter.
    const closed = value[end] === quote && (!value[end + 1] || /[\s,;&}\])]/.test(value[end + 1]));
    const consumedThrough = closed ? end + 1 : value.length;
    result += value.slice(copiedThrough, match.index) + match[1] + quote + '[REDACTED]' + quote;
    copiedThrough = consumedThrough;
    prefix.lastIndex = consumedThrough;
  }
  return result + value.slice(copiedThrough);
}

/** Best-effort credential masking; task content is intentionally retained for local export. */
export function redactLogText(text: string): string {
  const maskText = (value: string) =>
    redactQuotedCredentials(
      value.replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      ),
    )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, '$1 [REDACTED]')
      .replace(/\b((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
      .replace(
        /(?<![\w-])((?:["']?[\w-]*(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|authorization|cookie|credential)[\w-]*["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/(--(?:password|token|api-key|secret)\s+)\S+/gi, '$1[REDACTED]')
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
        '[REDACTED]',
      );
  const visit = (value: unknown, depth = 0): unknown => {
    if (depth > 40) return '[OMITTED NESTING]';
    if (typeof value === 'string') {
      if (value.trimStart().startsWith('{')) {
        try {
          return JSON.stringify(visit(JSON.parse(value), depth + 1));
        } catch {
          /* Text. */
        }
      }
      return maskText(value);
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretKey(key) ? '[REDACTED]' : visit(item, depth + 1),
        ]),
      );
    return value;
  };
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      return maskText(text.slice(0, start)) + JSON.stringify(visit(JSON.parse(text.slice(start))));
    } catch {
      /* Non-JSON log and stack traces retain their readable text. */
    }
  }
  return maskText(text);
}
