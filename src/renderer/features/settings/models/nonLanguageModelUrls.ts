import type { OnlineSpeechProviderProtocol } from '@shared/speech/onlineSpeechModels';

import { normalizeSpeechServiceBaseUrl } from '../../../../../plugins/sdk/speech-protocols';

export type NonLanguageModelKind =
  'speech-recognition' | 'speech-synthesis' | 'realtime-voice' | 'image' | 'video' | 'decision';

const ENDPOINT_SUFFIXES: Record<NonLanguageModelKind, string> = {
  'speech-recognition': '/realtime',
  'speech-synthesis': '/audio/speech',
  'realtime-voice': '/realtime',
  image: '/images/generations',
  video: '/videos',
  decision: '/systemone',
};

const SPEECH_ENDPOINT_SUFFIXES: Record<OnlineSpeechProviderProtocol['protocolId'], string> = {
  'openai-transcription-http': '/audio/transcriptions',
  'openai-speech-http': '/audio/speech',
  'openai-transcription-realtime': '/realtime',
  'openai-voice-realtime': '/realtime',
};

const removePathSuffix = (pathname: string, suffix: string): string =>
  pathname.toLowerCase().endsWith(suffix.toLowerCase())
    ? pathname.slice(0, -suffix.length) || '/'
    : pathname;

const appendUrlPath = (baseUrl: string, suffix: string): string => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path}${suffix}`;
  url.hash = '';
  return url.toString();
};

export const normalizeNonLanguageModelBaseUrl = (
  kind: NonLanguageModelKind,
  baseUrl: string,
  protocol?: OnlineSpeechProviderProtocol,
): string => {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  if (protocol) {
    try {
      const url = new URL(trimmed);
      if (
        protocol.protocolId === 'openai-transcription-realtime' &&
        [...url.searchParams.keys()].length === 1 &&
        url.searchParams.get('intent') === 'transcription'
      )
        url.search = '';
      return normalizeSpeechServiceBaseUrl(url.toString(), protocol);
    } catch {
      return trimmed;
    }
  }
  try {
    const url = new URL(trimmed);
    url.pathname = removePathSuffix(
      url.pathname.replace(/\/+$/, '') || '/',
      ENDPOINT_SUFFIXES[kind],
    );
    if (kind === 'speech-recognition' || kind === 'speech-synthesis' || kind === 'realtime-voice')
      url.pathname =
        url.pathname.replace(/\/(?:audio\/(?:transcriptions|speech)|realtime)$/i, '') || '/';
    if (kind === 'speech-recognition') url.searchParams.delete('intent');
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
};

export const buildNonLanguageModelEndpointPreview = (
  kind: NonLanguageModelKind,
  baseUrl: string,
  protocol?: OnlineSpeechProviderProtocol,
): string => {
  const normalized = normalizeNonLanguageModelBaseUrl(kind, baseUrl, protocol);
  if (!normalized) return '';
  const suffix = protocol ? SPEECH_ENDPOINT_SUFFIXES[protocol.protocolId] : ENDPOINT_SUFFIXES[kind];
  const realtime = protocol
    ? ['openai-transcription-realtime', 'openai-voice-realtime'].includes(protocol.protocolId)
    : kind === 'speech-recognition' || kind === 'realtime-voice';
  const transcription = protocol
    ? protocol.protocolId === 'openai-transcription-realtime'
    : kind === 'speech-recognition';

  try {
    const url = new URL(normalized);
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = `${path}${suffix}`;
    url.hash = '';
    if (!realtime) return url.toString();
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (transcription) url.searchParams.set('intent', 'transcription');
    return url.toString();
  } catch {
    return `${normalized}${suffix}${transcription ? '?intent=transcription' : ''}`;
  }
};

export const buildNonLanguageModelModelsUrl = (
  kind: NonLanguageModelKind,
  baseUrl: string,
  protocol?: OnlineSpeechProviderProtocol,
): string => {
  const normalized = normalizeNonLanguageModelBaseUrl(kind, baseUrl, protocol);
  const modelsUrl = new URL(appendUrlPath(normalized, '/models'));
  if (modelsUrl.protocol === 'ws:') modelsUrl.protocol = 'http:';
  if (modelsUrl.protocol === 'wss:') modelsUrl.protocol = 'https:';
  return modelsUrl.toString();
};

export const buildVoiceDiscoveryUrls = (
  baseUrl: string,
  protocol?: OnlineSpeechProviderProtocol,
): string[] => {
  const normalized = normalizeNonLanguageModelBaseUrl('speech-synthesis', baseUrl, protocol);
  const base = new URL(normalized);
  if (base.protocol === 'ws:') base.protocol = 'http:';
  if (base.protocol === 'wss:') base.protocol = 'https:';
  const serviceRoot = new URL(base.toString());
  serviceRoot.pathname = serviceRoot.pathname.replace(/\/v\d+\/?$/i, '') || '/';
  return [
    appendUrlPath(base.toString(), '/audio/voices'),
    appendUrlPath(base.toString(), '/voices'),
    appendUrlPath(serviceRoot.toString(), '/api/voices'),
  ];
};

export const buildNonLanguageModelOpenApiUrl = (
  kind: NonLanguageModelKind,
  baseUrl: string,
  protocol?: OnlineSpeechProviderProtocol,
): string => {
  const serviceRoot = new URL(normalizeNonLanguageModelBaseUrl(kind, baseUrl, protocol));
  serviceRoot.pathname = serviceRoot.pathname.replace(/\/v\d+\/?$/i, '') || '/';
  serviceRoot.search = '';
  return appendUrlPath(serviceRoot.toString(), '/openapi.json');
};
