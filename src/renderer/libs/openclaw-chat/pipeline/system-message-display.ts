/** Presentation only: keep Gateway transcripts and diagnostic errors intact. */
const LOG_SENTENCES = [
  'For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.',
  'For details, open Settings → Logs in the Control UI or run `openclaw logs --follow`.',
  'If it continues, open Settings → Logs in the Control UI or run `openclaw logs --follow`.',
  'Troubleshooting: run `openclaw logs --follow` in a terminal.',
];
const LOG_SENTENCE_PATTERNS = [
  /(^|\s+)For details, open Settings[\t ]+→[\t ]+Logs in the Control UI or run[\t ]+`?openclaw[\t ]+logs[\t ]+--follow`?(?:[\t ]+in your terminal)?\.(?=\s|$)/gi,
  /(^|\s+)If it continues, open Settings[\t ]+→[\t ]+Logs in the Control UI or run[\t ]+`?openclaw[\t ]+logs[\t ]+--follow`?\.(?=\s|$)/gi,
  /(^|\s+)Troubleshooting: run[\t ]+`?openclaw[\t ]+logs[\t ]+--follow`?[\t ]+in a terminal\.(?=\s|$)/gi,
];

export function cleanFailureDisplayText(text: string): string {
  return stripOpenClawLogHintText(text).trim().replace(/^⚠[\uFE0E\uFE0F]?\s*/u, '').trim();
}

export function stripOpenClawLogHintText(text: string, hidePartial = false): string {
  let result = text;
  for (const pattern of LOG_SENTENCE_PATTERNS) result = result.replace(pattern, '');
  if (hidePartial) {
    // Hold only a matching trailing prefix; release unrelated prose on divergence.
    const start = result.search(
      /\b(?:(?:For details|If it continues), open Settings|Troubleshooting: run)[^\n]*$/i,
    );
    if (start >= 0 && (start === 0 || /\s/.test(result[start - 1]))) {
      const tail = result
        .slice(start)
        .replace(/[\t ]+/g, ' ')
        .toLowerCase();
      if (
        LOG_SENTENCES.some(sentence => {
          const canonical = sentence.toLowerCase();
          return canonical.startsWith(tail) || canonical.replace(/`/g, '').startsWith(tail);
        })
      ) {
        result = result.slice(0, start).trimEnd();
      }
    }
  }
  return result;
}
