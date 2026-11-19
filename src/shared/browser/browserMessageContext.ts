import type { BrowserAnnotationDisplay, BrowserAnnotationDraft, BrowserPanelRect } from './browserAnnotation';
import {
  type BrowserRecordingDraft,
  parseRecordingContext,
  RECORDING_LIMITS,
  serializeRecording,
} from './browserRecording';

export const BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH = 8_000;
const EXTERNAL_BROWSER_CONTEXT_START = 'EXTERNAL_UNTRUSTED_CONTENT';
const EXTERNAL_BROWSER_CONTEXT_END = 'END_EXTERNAL_UNTRUSTED_CONTENT';
const EXTERNAL_BROWSER_CONTEXT_SOURCE = 'Source: Browser';
const EXTERNAL_BROWSER_CONTEXT_ID_PATTERN = '[a-f0-9]{16}';
const EXTERNAL_BROWSER_CONTEXT_OPEN = `<<<${EXTERNAL_BROWSER_CONTEXT_START} id="`;
const EXTERNAL_BROWSER_CONTEXT_CLOSE = `\n<<<${EXTERNAL_BROWSER_CONTEXT_END} id="`;
const EXTERNAL_BROWSER_CONTEXT_PATTERN = new RegExp(
  `^${EXTERNAL_BROWSER_CONTEXT_OPEN}(${EXTERNAL_BROWSER_CONTEXT_ID_PATTERN})">>>\\n${EXTERNAL_BROWSER_CONTEXT_SOURCE}\\n---\\n`,
);
const BROWSER_CONTEXT_LENGTH_PREFIX = 'content-length:';
const BROWSER_DISPLAY_LENGTH_PREFIX = 'display-metadata-length:';

export type ParsedBrowserAnnotationPrompt = {
  recording?: BrowserRecordingDraft;
  userText: string;
  annotations: BrowserAnnotationDisplay[];
  modelContext: string;
};

const boundedDisplayString = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';

const parseDisplayRect = (value: unknown): BrowserPanelRect | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item))) return null;
  return {
    x: Math.max(-100_000, Math.min(100_000, record.x as number)),
    y: Math.max(-100_000, Math.min(100_000, record.y as number)),
    width: Math.max(0, Math.min(100_000, record.width as number)),
    height: Math.max(0, Math.min(100_000, record.height as number)),
  };
};

const parseDisplayAnnotations = (value: string): BrowserAnnotationDisplay[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 4).flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const elementRecord =
        record.element && typeof record.element === 'object' && !Array.isArray(record.element)
          ? (record.element as Record<string, unknown>)
          : null;
      const rect = elementRecord ? parseDisplayRect(elementRecord.rect) : null;
      const element =
        elementRecord && rect
          ? {
              tag: boundedDisplayString(elementRecord.tag, 40).toLowerCase(),
              id: boundedDisplayString(elementRecord.id, 80),
              classes: Array.isArray(elementRecord.classes)
                ? elementRecord.classes
                    .slice(0, 3)
                    .map(item => boundedDisplayString(item, 60))
                    .filter(Boolean)
                : [],
              role: boundedDisplayString(elementRecord.role, 40),
              name: boundedDisplayString(elementRecord.name, 160),
              cssPath: boundedDisplayString(elementRecord.cssPath, 400),
              rect,
            }
          : undefined;
      return [
        {
          id: boundedDisplayString(record.id, 80),
          title: boundedDisplayString(record.title, 120),
          displayUrl: boundedDisplayString(record.displayUrl, 300),
          markedRegionCount:
            typeof record.markedRegionCount === 'number' &&
            Number.isFinite(record.markedRegionCount)
              ? Math.max(0, Math.min(8, Math.floor(record.markedRegionCount)))
              : 0,
          ...(boundedDisplayString(record.comment, 2_000)
            ? { comment: boundedDisplayString(record.comment, 2_000) }
            : {}),
          ...(element?.tag ? { element } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
};

export function serializeBrowserAnnotationContext(
  annotations: readonly BrowserAnnotationDraft[],
): string {
  const displayMetadata = JSON.stringify(
    annotations.map(annotation => ({
      id: annotation.display?.id ?? annotation.id,
      title: annotation.display?.title ?? annotation.title,
      displayUrl: annotation.display?.displayUrl ?? annotation.displayUrl,
      markedRegionCount: annotation.display?.markedRegionCount ?? annotation.markedRegionCount,
      ...(annotation.display?.comment || annotation.comment
        ? { comment: annotation.display?.comment ?? annotation.comment }
        : {}),
      ...(annotation.display?.element ? { element: annotation.display.element } : {}),
    })),
  );
  return `${BROWSER_DISPLAY_LENGTH_PREFIX}${displayMetadata.length}\n${displayMetadata}\n${annotations
    .map(annotation => annotation.modelContext)
    .join('\n\n')}`;
}

export function composeBrowserGatewayPrompt(
  userText: string,
  annotations: readonly BrowserAnnotationDraft[],
  recording?: BrowserRecordingDraft,
): string {
  if (!annotations.length && !recording) return userText;
  let context = serializeBrowserAnnotationContext(annotations);
  if (context.length > BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH) {
    throw new RangeError('Browser annotation context exceeds the supported length.');
  }
  if (recording) {
    const serialized = serializeRecording(recording);
    context = `recording-data-length:${serialized.length}\n${serialized}\n${context}`;
  }
  const boundaryId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `<<<${EXTERNAL_BROWSER_CONTEXT_START} id="${boundaryId}">>>\n${EXTERNAL_BROWSER_CONTEXT_SOURCE}\n---\n${BROWSER_CONTEXT_LENGTH_PREFIX}${context.length}\n${context}\n<<<${EXTERNAL_BROWSER_CONTEXT_END} id="${boundaryId}">>>\n\n${userText}`;
}

function readLengthDelimitedBrowserContext(value: string, lengthOffset: number, boundaryId: string) {
  if (!value.startsWith(BROWSER_CONTEXT_LENGTH_PREFIX, lengthOffset)) return null;
  const headerEnd = value.indexOf('\n', lengthOffset);
  if (headerEnd < 0) return null;
  const lengthText = value.slice(lengthOffset + BROWSER_CONTEXT_LENGTH_PREFIX.length, headerEnd);
  if (!/^\d+$/.test(lengthText)) return null;
  const contextLength = Number(lengthText);
  if (!Number.isSafeInteger(contextLength)) return null;
  const contextStart = headerEnd + 1;
  const contextEnd = contextStart + contextLength;
  const closingBoundary = `${EXTERNAL_BROWSER_CONTEXT_CLOSE}${boundaryId}">>>`;
  if (!value.startsWith(closingBoundary, contextEnd)) return null;
  const textOffset = contextEnd + closingBoundary.length;
  // Gateway history can trim the blank line following an empty user prompt.
  if (textOffset !== value.length && !value.startsWith('\n\n', textOffset)) return null;
  return { contextStart, contextEnd, userTextStart: textOffset + 2 };
}

/** Keep the original delimiters when reusing the native identity of a browser draft. */
export function readBrowserPromptBoundary(value: string) {
  const start = EXTERNAL_BROWSER_CONTEXT_PATTERN.exec(value);
  if (!start?.[1]) return null;
  const id = start[1];
  const envelope = readLengthDelimitedBrowserContext(value, start[0].length, id);
  if (!envelope) return null;
  const openingOffset = EXTERNAL_BROWSER_CONTEXT_OPEN.length;
  const closingOffset = envelope.contextEnd + EXTERNAL_BROWSER_CONTEXT_CLOSE.length;
  return {
    id,
    userTextStart: envelope.userTextStart,
    replace(replacement: string): string {
      return value.slice(0, openingOffset) + replacement +
        value.slice(openingOffset + id.length, closingOffset) + replacement +
        value.slice(closingOffset + id.length);
    },
  };
}

function parseLengthDelimitedBrowserContext(
  value: string,
  lengthOffset: number,
  boundaryId: string,
): ParsedBrowserAnnotationPrompt | null {
  const envelope = readLengthDelimitedBrowserContext(value, lengthOffset, boundaryId);
  if (envelope) {
    let context = value.slice(envelope.contextStart, envelope.contextEnd);
    let recording: BrowserRecordingDraft | undefined;
    if (context.startsWith('recording-data-length:')) {
      const lineEnd = context.indexOf('\n');
      const length = Number(context.slice('recording-data-length:'.length, lineEnd));
      if (
        lineEnd < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > RECORDING_LIMITS.textLength
      )
        return null;
      recording =
        parseRecordingContext(context.slice(lineEnd + 1, lineEnd + 1 + length)) ?? undefined;
      if (!recording || context[lineEnd + 1 + length] !== '\n') return null;
      context = context.slice(lineEnd + 2 + length);
    }
    let annotations: BrowserAnnotationDisplay[] = [];
    let modelContext = context;
    if (context.startsWith(BROWSER_DISPLAY_LENGTH_PREFIX)) {
      const metadataHeaderEnd = context.indexOf('\n');
      const metadataLengthText = context.slice(
        BROWSER_DISPLAY_LENGTH_PREFIX.length,
        metadataHeaderEnd,
      );
      if (metadataHeaderEnd >= 0 && /^\d+$/.test(metadataLengthText)) {
        const metadataLength = Number(metadataLengthText);
        const metadataStart = metadataHeaderEnd + 1;
        if (
          Number.isSafeInteger(metadataLength) &&
          metadataLength >= 0 &&
          metadataLength <= 16_000 &&
          context.length >= metadataStart + metadataLength
        ) {
          annotations = parseDisplayAnnotations(
            context.slice(metadataStart, metadataStart + metadataLength),
          );
          modelContext = context.slice(metadataStart + metadataLength).replace(/^\n/u, '');
        }
      }
    }
    return {
      userText: value.slice(envelope.userTextStart),
      annotations,
      modelContext,
      ...(recording ? { recording } : {}),
    };
  }
  return null;
}

export function parseBrowserAnnotationPrompt(value: string): ParsedBrowserAnnotationPrompt | null {
  const externalStart = EXTERNAL_BROWSER_CONTEXT_PATTERN.exec(value);
  if (externalStart?.[1]) {
    const boundaryId = externalStart[1];
    const parsed = parseLengthDelimitedBrowserContext(value, externalStart[0].length, boundaryId);
    if (parsed) return parsed;
    // Persisted recording-only envelopes can have stale lengths after Gateway
    // text sanitization. Recover only the exact compact-JSON grammar, never by
    // searching page text for a closing marker. Annotation contexts remain
    // strictly length-delimited because they can contain arbitrary newlines.
    const tail = value.slice(externalStart[0].length);
    const recovered =
      /^content-length:(\d+)\nrecording-data-length:(\d+)\n([^\n]+)\ndisplay-metadata-length:2\n\[\]\n\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>(?:\n\n([\s\S]*))?$/.exec(
        tail,
      );
    if (!recovered || recovered[4] !== boundaryId) return null;
    const declaredContext = Number(recovered[1]);
    const declaredRecording = Number(recovered[2]);
    const json = recovered[3];
    const actualContext =
      `recording-data-length:${recovered[2]}\n${json}\ndisplay-metadata-length:2\n[]\n`.length;
    if (
      !Number.isSafeInteger(declaredContext) ||
      !Number.isSafeInteger(declaredRecording) ||
      declaredRecording > RECORDING_LIMITS.textLength ||
      declaredRecording <= json.length ||
      declaredContext - actualContext !== declaredRecording - json.length
    )
      return null;
    const recording = parseRecordingContext(json);
    return recording
      ? { userText: recovered[5] ?? '', annotations: [], modelContext: '', recording }
      : null;
  }
  return null;
}

export function extractBrowserAnnotationUserText(value: string): string | null {
  return parseBrowserAnnotationPrompt(value)?.userText ?? null;
}
