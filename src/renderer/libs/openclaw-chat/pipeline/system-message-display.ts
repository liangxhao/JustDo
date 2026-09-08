/** Presentation only: keep Gateway transcripts and diagnostic errors intact. */
const LOG_COMMAND = 'openclaw logs --follow';
const LOG_SENTENCE = 'To view logs, run `openclaw logs --follow` in a terminal.';
const LOG_SENTENCE_PATTERN =
  /(^|\s+)To view logs, run[\t ]+`?openclaw[\t ]+logs[\t ]+--follow`?[\t ]+in a terminal\.(?=\s|$)/gi;

function isLogLine(line: string, partial: boolean): boolean {
  const match = /^[\t ]*(`?openclaw.*)/i.exec(line);
  // A streaming legacy heading can arrive before any command characters.
  const heading = /^[\t ]*Logs?:[\t ]*(.*)$/i.exec(line);
  const value = heading?.[1] ?? match?.[1];
  if (value === undefined) return false;
  const command = value
    .trim()
    .replace(/^`/, '')
    .replace(/`$/, '')
    .trim()
    .replace(/[\t ]+/g, ' ')
    .toLowerCase();
  return partial ? LOG_COMMAND.startsWith(command) : command === LOG_COMMAND;
}

export function stripOpenClawLogHintText(text: string, hidePartial = false): string {
  let result = text.replace(LOG_SENTENCE_PATTERN, '');
  if (hidePartial) {
    // Hold only a matching trailing prefix; release unrelated prose on divergence.
    const start = result.search(/\bTo view logs, run[^\n]*$/i);
    if (start >= 0 && (start === 0 || /\s/.test(result[start - 1]))) {
      const tail = result
        .slice(start)
        .replace(/[\t ]+/g, ' ')
        .toLowerCase();
      const canonical = LOG_SENTENCE.toLowerCase();
      if (canonical.startsWith(tail) || canonical.replace(/`/g, '').startsWith(tail)) {
        result = result.slice(0, start).trimEnd();
      }
    }
  }
  const lines = result.split(/\r?\n/);
  if (!lines.some((line, index) => isLogLine(line, hidePartial && index === lines.length - 1))) {
    return result;
  }
  return lines
    .filter((line, index) => !isLogLine(line, hidePartial && index === lines.length - 1))
    .join('\n');
}
