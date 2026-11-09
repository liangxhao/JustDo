import {
  COLLABORATION_REFERENCE_CONTEXT,
  type CollaborationQuote,
  MESSAGE_QUOTE_KIND,
  teamQuoteContext,
  validCollaborationQuote,
} from '../contracts/messageQuote';
import { agentTeamTranslations } from './translations';

function collaborationReferenceDisplay(line: string, language: 'zh' | 'en'): string | null {
  const marker = '> ' + COLLABORATION_REFERENCE_CONTEXT;
  if (!line.startsWith(marker)) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(marker.length));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const locator = parsed as Record<string, unknown>;
    const required = ['roomId', 'sourceSessionId', 'targetAgentId', 'targetSessionId', 'targetSessionKey'];
    const optional = ['priorRoundId', 'deliveryId'];
    if (required.some(key => typeof locator[key] !== 'string') ||
        optional.some(key => key in locator && typeof locator[key] !== 'string') ||
        Object.keys(locator).some(key => !required.includes(key) && !optional.includes(key)))
      return null;
    const quote = {
      kind: MESSAGE_QUOTE_KIND.COLLABORATION,
      id: '',
      text: '',
      ...locator,
    } as CollaborationQuote;
    // Only our exact serialized shape is a transport marker. Lookalike user JSON
    // (including extra, duplicated, reordered or malformed fields) stays visible.
    if (!validCollaborationQuote(quote) || line !== '> ' + teamQuoteContext(quote)) return null;
    return '> ' + agentTeamTranslations[language][quote.priorRoundId
      ? 'teamCollaborationBatchReferenceDisplay'
      : 'teamCollaborationReferenceDisplay'].replace('{member}', quote.targetAgentId);
  } catch {
    return null;
  }
}

/** Visible text only: never run this projection on an editor or transport envelope. */
export function renderTeamQuoteText(source: string, language: 'zh' | 'en' = 'en'): string {
  if (!source.includes('> ' + COLLABORATION_REFERENCE_CONTEXT)) return source;
  const lines = source.split('\n');
  let fence: { character: string; length: number } | undefined;
  return lines.map((line, index) => {
    const fenceLine = line.replace(/^(?: {0,3}> ?)+/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(fenceLine);
    if (delimiter) {
      if (!fence) {
        fence = { character: delimiter[1][0], length: delimiter[1].length };
      } else if (delimiter[1][0] === fence.character &&
          delimiter[1].length >= fence.length && !delimiter[2].trim()) {
        fence = undefined;
      }
      return line;
    }
    if (fence || (index > 0 && lines[index - 1].trim()) ||
        (index + 1 < lines.length && lines[index + 1].trim())) return line;
    return collaborationReferenceDisplay(line, language) ?? line;
  }).join('\n');
}
