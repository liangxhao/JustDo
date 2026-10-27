import { parseManagedOutgoingMediaSource } from '@shared/openclaw/assistantMedia';

import {
  type SummaryResource,
  type SummaryResourceTarget,
  summaryWebUrl,
} from '@/libs/openclaw-chat/model/timeline/session-summary-resources';

interface ResourceNavigation {
  sessionKey?: string;
  isCurrent: () => boolean;
  resolveArtifact: (
    target: Extract<SummaryResourceTarget, { kind: 'artifact' }>,
    title: string,
  ) => SummaryResource | null;
  readAttachment: (
    target: Extract<SummaryResourceTarget, { kind: 'attachment' }>,
  ) => { url: string; label: string; mimeType?: string; kind?: string } | null;
  openFile: (path: string) => void;
  openImage: (src: string, label: string) => void;
  openUrl: (url: string) => void;
  openMedia?: (url: string, label: string, kind: 'audio' | 'video') => void;
}

/** Reuse existing files and loaded attachments; opening never downloads or saves a copy. */
export async function openSummaryResource(
  resource: SummaryResource,
  navigation: ResourceNavigation,
): Promise<boolean> {
  if (!navigation.isCurrent()) return false;
  if (resource.target.kind === 'file') {
    navigation.openFile(resource.target.path);
    return true;
  }
  let url: string | undefined;
  let mimeType = resource.mimeType;
  let title = resource.title;
  let kind: string | undefined;
  if (resource.target.kind === 'artifact') {
    const original = navigation.resolveArtifact(resource.target, resource.title);
    if (!original || original.target.kind === 'artifact' || !navigation.isCurrent()) return false;
    return openSummaryResource(original, navigation);
  } else if (resource.target.kind === 'attachment') {
    const attachment = navigation.readAttachment(resource.target);
    if (!attachment || !navigation.isCurrent()) return false;
    url = attachment.url;
    title = attachment.label;
    mimeType = attachment.mimeType;
    kind = attachment.kind;
  } else {
    url = resource.target.url;
  }
  const mediaKind = mimeType?.startsWith('audio/')
    ? 'audio'
    : mimeType?.startsWith('video/')
      ? 'video'
      : kind;
  if (
    navigation.openMedia &&
    url &&
    navigation.sessionKey &&
    (mediaKind === 'audio' || mediaKind === 'video') &&
    parseManagedOutgoingMediaSource(url, navigation.sessionKey)
  ) {
    navigation.openMedia(url, title, mediaKind);
    return true;
  }
  const web = summaryWebUrl(url);
  if (
    url &&
    (/^data:image\/[a-z\d.+-]+[;,]/iu.test(url) || (web && mimeType?.startsWith('image/')))
  ) {
    navigation.openImage(url, title);
    return true;
  }
  if (web) {
    navigation.openUrl(web);
    return true;
  }
  return false;
}
