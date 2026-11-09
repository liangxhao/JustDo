import { parseBrowserAnnotationPrompt } from '../browser/browserMessageContext';
import { type CoworkAttachmentPayload, parseCoworkAttachments } from './attachments';

/** Validate content independently of the optional user-written text. */
export function hasMessageInput(input: {
  prompt: string;
  gatewayPrompt?: string;
  attachments?: unknown;
}): boolean {
  return Boolean(
    input.prompt.trim() ||
    (typeof input.gatewayPrompt === 'string' && input.gatewayPrompt.trim()) ||
    parseCoworkAttachments(input.attachments).length,
  );
}

/** Use readable metadata, never the browser envelope or local absolute paths. */
export function getMessageTitleInput(
  prompt: string,
  attachments: readonly CoworkAttachmentPayload[] = [],
  gatewayPrompt?: string,
): string {
  const lines = prompt.split(/\r?\n/u);
  const text = lines
    .filter(line => !line.startsWith('MEDIA:'))
    .join('\n')
    .trim();
  if (text) return text;
  const browser = gatewayPrompt ? parseBrowserAnnotationPrompt(gatewayPrompt) : null;
  const browserTitles =
    browser?.annotations
      .flatMap(annotation => [annotation.comment?.trim(), annotation.title?.trim()])
      .filter(Boolean) ?? [];
  if (browserTitles.length) return browserTitles.join('\n').slice(0, 2000);
  if (browser?.recording?.title.trim()) return browser.recording.title.trim();
  const names = [
    ...attachments.map(attachment => attachment.name),
    ...lines.filter(line => line.startsWith('MEDIA:')).map(line => line.slice(6)),
  ]
    .map(name => name.split(/[/\\]/u).pop()?.trim())
    .filter(Boolean);
  return names.join('\n').slice(0, 2000);
}
