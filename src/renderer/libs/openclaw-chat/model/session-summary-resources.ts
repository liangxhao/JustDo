import type { ArtifactSummary } from '@shared/openclaw/artifacts';
import { OPENCLAW_NESTED_TOOL_CUSTOM_TYPE } from '@shared/openclaw/constants';
import MarkdownIt from 'markdown-it';

import { getTranscriptMedia, type RenderableAttachment } from '../attachments';
import { readCollapsedDeliveryArtifacts } from '../pipeline/history-display-normalizer';
import { normalizeMessage } from '../pipeline/message-normalizer';
import {
  isToolResultType,
  readToolName,
  readToolOutput,
  unwrapToolMessage,
} from './tool-message-adapter';
import { readTranscriptIdentity } from './transcript-identity';

export type SummaryResourceTarget =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'media'; url: string }
  | { kind: 'attachment'; messageKey: string; version: number; index: number }
  | { kind: 'artifact'; artifactId: string; assistantOnly: boolean; messageSeq?: number };

export interface SummaryResource {
  id: string;
  title: string;
  mimeType?: string;
  target: SummaryResourceTarget;
}

export interface SessionSummaryResources {
  sessionKey: string;
  outputs: SummaryResource[];
  sources: SummaryResource[];
  outputsLoading: boolean;
  outputsUnavailable: boolean;
  omittedOversized: boolean;
}

const parser = new MarkdownIt({ html: false, linkify: false });
const messageVersions = new WeakMap<object, number>();
let nextMessageVersion = 0;
function messageReference(value: object) {
  let version = messageVersions.get(value);
  if (version === undefined) {
    version = ++nextMessageVersion;
    messageVersions.set(value, version);
  }
  const identity =
    readTranscriptIdentity(value) ?? readTranscriptIdentity(unwrapToolMessage(value));
  return {
    version,
    messageKey: identity ? `${identity.kind}:${identity.value}` : `ephemeral:${version}`,
  };
}

export function resolveSummaryAttachment(
  messages: readonly unknown[],
  target: Extract<SummaryResourceTarget, { kind: 'attachment' }>,
) {
  const source = messages.find(value => {
    if (!value || typeof value !== 'object') return false;
    const reference = messageReference(value);
    return reference.messageKey === target.messageKey && reference.version === target.version;
  });
  const message = unwrapToolMessage(source);
  if (!message) return null;
  const item = normalizeMessage(message).content[target.index];
  return item?.type === 'attachment' ? item.attachment : null;
}
parser.validateLink = () => true; // Targets are admitted by filePath/summaryWebUrl below.
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function summaryWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function webResourceId(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return `url:${url.href}`;
}

function filePath(value: string): string | null {
  if (!value || value.length > 4096 || /[\u0000-\u001f]/u.test(value)) return null;
  if (/^file:/iu.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return null;
      const path = decodeURIComponent(url.pathname);
      return filePath(
        url.hostname ? `//${url.hostname}${path}` : path.replace(/^\/([a-z]:\/)/iu, '$1'),
      );
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value) && !/^[a-z]:[\\/]/iu.test(value)) return null;
  if (value.startsWith('/api/')) return null;
  return /^(?:[a-z]:[\\/]|\/|\.\.?[\\/])/iu.test(value) ||
    /^[^?#]*\.(?:md|txt|csv|jsonl?|html?|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|mp[34]|wav|zip)$/iu.test(
      value,
    )
    ? value
    : null;
}

function resourceForUrl(url: string, title: string, mimeType?: string): SummaryResource | null {
  const web = summaryWebUrl(url);
  const path = filePath(url);
  const inline = /^data:[^;,]+;base64,/iu.test(url);
  if (!web && !path && !inline) return null;
  return {
    id: path ? `file:${path.replace(/\\/gu, '/')}` : web ? webResourceId(web) : `url:${url}`,
    title: title || (path ? (path.split(/[\\/]/u).pop() ?? path) : new URL(web ?? url).hostname),
    mimeType,
    target: path
      ? { kind: 'file', path }
      : inline || mimeType?.match(/^(?:image|audio|video)\//u)
        ? { kind: 'media', url: web ?? url }
        : { kind: 'url', url: web! },
  };
}

function matchesNativeArtifactTitle(
  message: Record<string, unknown>,
  attachment: RenderableAttachment,
  title: string,
): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some(value => {
    const block = record(value);
    const nativeTitle = [
      block.title,
      block.fileName,
      block.filename,
      block.alt,
      record(block.attachment).label,
    ].find(value => typeof value === 'string' && value.trim());
    if (typeof nativeTitle !== 'string' || nativeTitle.trim() !== title) return false;
    return normalizeMessage({ role: message.role, content: [block] }).content.some(
      item =>
        item.type === 'attachment' &&
        item.attachment.url === attachment.url &&
        item.attachment.kind === attachment.kind &&
        item.attachment.artifactId === attachment.artifactId,
    );
  });
}

/** Resolve an existing delivery reference, never fetch or create an artifact copy. */
export function resolveSummaryArtifactResource(
  messages: readonly unknown[],
  target: Extract<SummaryResourceTarget, { kind: 'artifact' }>,
  title: string,
): SummaryResource | null {
  for (const value of messages) {
    const message = unwrapToolMessage(value);
    if (!message) continue;
    const normalized = normalizeMessage(message);
    if (target.assistantOnly && normalized.role !== 'assistant') continue;
    if (!['assistant', 'user'].includes(normalized.role)) continue;
    const deliveryLinks = readCollapsedDeliveryArtifacts(value).filter(
      link =>
        link.artifactId === target.artifactId ||
        (!link.artifactId &&
          target.messageSeq !== undefined &&
          link.messageSeq === target.messageSeq &&
          link.title === title),
    );
    if (deliveryLinks.length === 1) {
      const original = resourceForUrl(
        deliveryLinks[0].path,
        deliveryLinks[0].title,
        deliveryLinks[0].mimeType,
      );
      if (original) return original;
    }
    const attachments = normalized.content.flatMap((item, index) =>
      item.type === 'attachment' ? [{ attachment: item.attachment, index }] : [],
    );
    const exact = attachments.filter(item => item.attachment.artifactId === target.artifactId);
    const seq = record(record(value).__openclaw).seq ?? record(message.__openclaw).seq;
    const candidates = exact.length
      ? exact
      : target.messageSeq !== undefined && seq === target.messageSeq
        ? attachments.filter(
            item =>
              !item.attachment.artifactId &&
              (item.attachment.label === title ||
                matchesNativeArtifactTitle(message, item.attachment, title)),
          )
        : [];
    if (candidates.length !== 1) continue;
    const { attachment, index } = candidates[0];
    const direct = attachment.url.startsWith('data:')
      ? null
      : resourceForUrl(attachment.url, attachment.label, attachment.mimeType);
    if (direct) return direct;
    const originals = getTranscriptMedia(message).flatMap(item => {
      if (item.path.startsWith('data:')) return [];
      const resource = resourceForUrl(item.path, item.fileName ?? '', item.mimeType);
      return resource?.target.kind === 'file' ? [resource] : [];
    });
    const names = new Set([attachment.label, title]);
    const namedOriginals = originals.filter(item => names.has(item.title));
    if (
      namedOriginals.length === 1 &&
      attachments.filter(item => names.has(item.attachment.label)).length === 1
    )
      return namedOriginals[0];
    if (
      originals.length === 1 &&
      attachments.length === 1 &&
      attachment.mimeType?.startsWith('image/') &&
      originals[0].mimeType?.startsWith('image/')
    )
      return originals[0];
    if (attachment.url.startsWith('data:') && value && typeof value === 'object') {
      return {
        id: `attachment:${messageReference(value).messageKey}:${index}`,
        title: attachment.label,
        mimeType: attachment.mimeType,
        target: { kind: 'attachment', ...messageReference(value), index },
      };
    }
  }
  return null;
}

function markdownFiles(text: string): SummaryResource[] {
  if (text.length > 500_000) return [];
  return parser.parse(text, {}).flatMap(block => {
    const tokens = block.children ?? [];
    return tokens.flatMap((token, index) => {
      const href =
        token.type === 'image'
          ? token.attrGet('src')
          : token.type === 'link_open'
            ? token.attrGet('href')
            : null;
      if (!href) return [];
      let decoded: string;
      try {
        decoded = /^file:/iu.test(href) ? href : decodeURIComponent(href);
      } catch {
        return [];
      }
      const path = filePath(decoded);
      if (!path) return [];
      const label = token.type === 'image' ? token.content : (tokens[index + 1]?.content ?? '');
      const resource = resourceForUrl(path, label);
      return resource ? [resource] : [];
    });
  });
}

/** Only native tool-role records and the Gateway's nested activity envelope carry web evidence. */
function webToolResults(message: Record<string, unknown>): Record<string, unknown>[] {
  if (['toolResult', 'tool_result', 'tool'].includes(String(message.role))) return [message];
  if (
    message.role !== 'custom' ||
    message.customType !== OPENCLAW_NESTED_TOOL_CUSTOM_TYPE ||
    message.display !== true ||
    message.excludeFromContext !== true ||
    !Array.isArray(message.content)
  )
    return [];
  return message.content.flatMap(value => {
    const block = record(value);
    return isToolResultType(block.type) && block.role === 'toolResult' ? [block] : [];
  });
}

/** Read successful native web tool evidence, never arbitrary URLs in tool prose. */
function webSources(message: Record<string, unknown>): SummaryResource[] {
  const name = readToolName(message);
  if (!['web_search', 'web_fetch'].includes(String(name)) || message.isError === true) return [];
  let payload = record(message.details);
  if (!Object.keys(payload).length) {
    const text = readToolOutput(message) ?? '';
    if (text.length > 500_000) return [];
    try {
      payload = record(JSON.parse(text));
      if (Object.keys(record(payload.details)).length) payload = record(payload.details);
      else if (Array.isArray(payload.content)) {
        const nested = record(payload.content[0]).text;
        if (typeof nested === 'string' && nested.length <= 500_000)
          payload = record(JSON.parse(nested));
      }
    } catch {
      return [];
    }
  }
  const external = record(payload.externalContent);
  if (external.source !== name || external.untrusted !== true || external.wrapped !== true)
    return [];
  const rows =
    name === 'web_fetch'
      ? typeof payload.status === 'number' && payload.status >= 200 && payload.status < 300
        ? [{ url: payload.finalUrl ?? payload.url, title: payload.title }]
        : []
      : payload.kind === 'results' && Array.isArray(payload.results)
        ? payload.results
        : payload.kind === 'answer' && Array.isArray(payload.citations)
          ? payload.citations
          : [];
  return rows.slice(0, 30).flatMap(value => {
    const row = record(value);
    const url = summaryWebUrl(row.url);
    if (!url) return [];
    // Only strip the native boundary frame. Its text remains inert UI data.
    const framed =
      typeof row.title === 'string'
        ? /<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>\r?\nSource: [^\r\n]+\r?\n---\r?\n([\s\S]*?)\r?\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/u.exec(
            row.title,
          )?.[2]
        : undefined;
    return [
      {
        id: webResourceId(url),
        title: framed?.slice(0, 240) || new URL(url).hostname,
        target: { kind: 'url' as const, url },
      },
    ];
  });
}

/** Ephemeral projection of the Renderer-owned native history; never a transcript store. */
export function projectSessionSummaryResources(
  messages: readonly unknown[],
  artifacts: readonly ArtifactSummary[],
): Pick<SessionSummaryResources, 'outputs' | 'sources'> {
  const outputs = new Map<string, SummaryResource>();
  const sources = new Map<string, SummaryResource>();
  const artifactMessages = new Map<string | number, unknown[]>();
  for (const value of messages) {
    const message = unwrapToolMessage(value);
    if (!message) continue;
    const identities: Array<string | number> = [];
    const seq = record(record(value).__openclaw).seq ?? record(message.__openclaw).seq;
    if (typeof seq === 'number') identities.push(seq);
    for (const link of readCollapsedDeliveryArtifacts(value)) {
      if (link.artifactId) identities.push(link.artifactId);
      if (link.messageSeq !== undefined) identities.push(link.messageSeq);
    }
    for (const item of Array.isArray(message.content) ? message.content : []) {
      const block = record(item);
      const id = block.artifactId ?? record(block.attachment).artifactId;
      if (typeof id === 'string') identities.push(id);
    }
    for (const identity of new Set(identities)) {
      const items = artifactMessages.get(identity) ?? [];
      items.push(value);
      artifactMessages.set(identity, items);
    }
  }
  for (const artifact of artifacts) {
    const target: Extract<SummaryResourceTarget, { kind: 'artifact' }> = {
      kind: 'artifact',
      artifactId: artifact.id,
      assistantOnly: true,
      messageSeq: artifact.messageSeq,
    };
    const original = resolveSummaryArtifactResource(
      artifactMessages.get(artifact.id) ?? artifactMessages.get(artifact.messageSeq ?? -1) ?? [],
      target,
      artifact.title,
    );
    const resource: SummaryResource = original
      ? {
          ...original,
          title: artifact.title,
          mimeType: original.mimeType ?? artifact.mimeType,
        }
      : {
          id: `artifact:${artifact.id}`,
          title: artifact.title,
          mimeType: artifact.mimeType,
          target,
        };
    outputs.set(resource.id, resource);
  }
  const artifactIds = new Set(artifacts.map(item => item.id));
  const artifactResourceIds = new Set(outputs.keys());
  const addResource = (destination: Map<string, SummaryResource>, resource: SummaryResource) => {
    if (destination === outputs && artifactResourceIds.has(resource.id)) return;
    destination.set(resource.id, resource);
  };
  for (const value of messages) {
    const message = unwrapToolMessage(value) ?? {};
    if (!Object.keys(message).length) continue;
    for (const result of webToolResults(message)) {
      for (const resource of webSources(result)) {
        const previous = sources.get(resource.id);
        if (!previous || resource.title !== new URL(resource.id.slice(4)).hostname)
          sources.set(resource.id, resource);
      }
    }
    const normalized = normalizeMessage(message);
    if (!['assistant', 'user'].includes(normalized.role)) continue;
    const destination = normalized.role === 'assistant' ? outputs : sources;
    const media = getTranscriptMedia(message);
    const mediaResources = media.flatMap(item => {
      if (item.path.startsWith('data:')) return [];
      const resource = resourceForUrl(item.path, item.fileName ?? '', item.mimeType);
      return resource ? [resource] : [];
    });
    for (const resource of mediaResources) addResource(destination, resource);
    const attachments = normalized.content.flatMap(item =>
      item.type === 'attachment' ? [item.attachment] : [],
    );
    for (const [index, item] of normalized.content.entries()) {
      if (item.type === 'attachment') {
        const attachment = item.attachment;
        if (normalized.role === 'assistant' && artifactIds.has(attachment.artifactId ?? ''))
          continue;
        const namedMedia = mediaResources.filter(resource => resource.title === attachment.label);
        const coveredInline =
          (namedMedia.length === 1 &&
            attachments.filter(item => item.label === attachment.label).length === 1) ||
          (mediaResources.length === 1 &&
            attachments.length === 1 &&
            attachment.mimeType?.startsWith('image/') &&
            mediaResources[0].mimeType?.startsWith('image/'));
        if (!attachment.artifactId && attachment.url.startsWith('data:') && coveredInline) continue;
        const artifactTarget: Extract<SummaryResourceTarget, { kind: 'artifact' }> | null =
          attachment.artifactId
            ? {
                kind: 'artifact',
                artifactId: attachment.artifactId,
                assistantOnly: normalized.role === 'assistant',
              }
            : null;
        const resource = artifactTarget
          ? (resolveSummaryArtifactResource([value], artifactTarget, attachment.label) ?? {
              id: `artifact:${attachment.artifactId}`,
              title: attachment.label,
              mimeType: attachment.mimeType,
              target: artifactTarget,
            })
          : attachment.url.startsWith('data:') && value && typeof value === 'object'
            ? {
                id: `attachment:${messageReference(value).messageKey}:${index}`,
                title: attachment.label,
                mimeType: attachment.mimeType,
                target: { kind: 'attachment' as const, ...messageReference(value), index },
              }
            : resourceForUrl(attachment.url, attachment.label, attachment.mimeType);
        if (resource) addResource(destination, resource);
      } else if (item.type === 'text' && item.text) {
        for (const resource of markdownFiles(item.text)) addResource(destination, resource);
      } else if (item.type === 'canvas' && normalized.role === 'assistant') {
        const url = 'url' in item.preview ? summaryWebUrl(item.preview.url) : null;
        if (url) {
          const resource = resourceForUrl(url, item.preview.title ?? '');
          if (resource) addResource(outputs, resource);
        }
      }
    }
  }
  return { outputs: [...outputs.values()].reverse(), sources: [...sources.values()].reverse() };
}
