'use strict';

// Capability: route OpenAI realtime transcription through the configured provider base URL.
// Target: openclaw@2026.9.6 OpenAI realtime transcription provider factory.
// Scope: direct API-key WebSocket transcription; other OpenAI APIs remain unchanged.
// Safety: preserve the public OpenAI endpoint when no provider base URL is configured.
// Remove when: upstream OpenAI realtime transcription accepts a provider base URL.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_OPENAI_REALTIME_TRANSCRIPTION_BASE_URL_V2026_9_6';
const PATCH_MARKER_PATTERN = /JUSTDO_OPENAI_REALTIME_TRANSCRIPTION_BASE_URL_V\d+_\d+_\d+/gu;
const URL_CONSTANT =
  'const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";';
const URL_HELPER = [
  'function resolveOpenAIRealtimeTranscriptionUrl(baseUrl) {',
  '\tif (!baseUrl) return OPENAI_REALTIME_TRANSCRIPTION_URL;',
  '\tconst url = new URL(baseUrl);',
  '\tif (url.protocol === "http:") url.protocol = "ws:";',
  '\telse if (url.protocol === "https:") url.protocol = "wss:";',
  '\tconst pathname = url.pathname.replace(/\\/+$/, "");',
  '\turl.pathname = pathname.endsWith("/realtime") ? pathname : `${pathname}/realtime`;',
  '\turl.searchParams.set("intent", "transcription");',
  '\treturn url.toString();',
  `}/*${MARKER}*/`,
].join('\n');

const ORIGINAL_ANCHORS = {
  normalizedConfig: '\t\tlanguage: normalizeOptionalString(raw?.language),',
  sessionCreation:
    '\treturn runtime.createRealtimeTranscriptionWebSocketSession({\n' +
    '\t\tproviderId: "openai",\n' +
    '\t\tcallbacks: config,\n' +
    '\t\turl: OPENAI_REALTIME_TRANSCRIPTION_URL,',
  headerBaseUrl: '\t\t\t\tbaseUrl: OPENAI_REALTIME_TRANSCRIPTION_URL,',
  providerConfig: '\t\t\t\tapiKey: config.apiKey,\n' + '\t\t\t\tlanguage: config.language,',
};

const PATCHED_ANCHORS = {
  normalizedConfig:
    '\t\tbaseUrl: normalizeOptionalString(raw?.baseUrl),\n' +
    '\t\tlanguage: normalizeOptionalString(raw?.language),',
  sessionCreation:
    '\tconst transcriptionUrl = resolveOpenAIRealtimeTranscriptionUrl(config.baseUrl);\n' +
    '\treturn runtime.createRealtimeTranscriptionWebSocketSession({\n' +
    '\t\tproviderId: "openai",\n' +
    '\t\tcallbacks: config,\n' +
    '\t\turl: transcriptionUrl,',
  headerBaseUrl: '\t\t\t\tbaseUrl: transcriptionUrl,',
  providerConfig:
    '\t\t\t\tapiKey: config.apiKey,\n' +
    '\t\t\t\tbaseUrl: config.baseUrl,\n' +
    '\t\t\t\tlanguage: config.language,',
};

function resolveOpenAIRealtimeTranscriptionUrl(baseUrl) {
  if (!baseUrl) return 'wss://api.openai.com/v1/realtime?intent=transcription';
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/u, '');
  url.pathname = pathname.endsWith('/realtime') ? pathname : `${pathname}/realtime`;
  url.searchParams.set('intent', 'transcription');
  return url.toString();
}

function targets(runtimeDir) {
  return findFilesContaining(
    runtimeDir,
    [URL_CONSTANT, 'function createOpenAIRealtimeTranscriptionSession(', 'providerId: "openai"'],
    { includeBundle: false },
  );
}

function assertTargetShape(files) {
  if (files.length !== 2) {
    throw new Error(
      `OpenAI realtime transcription base URL target count is ${files.length}, expected 2`,
    );
  }
}

function transform(content, filePath) {
  const markers = [...content.matchAll(PATCH_MARKER_PATTERN)].map(match => match[0]);
  const currentMarkerCount = countOccurrences(content, MARKER);
  const historicalMarkerCount = markers.filter(marker => marker !== MARKER).length;
  const originalCounts = Object.values(ORIGINAL_ANCHORS).map(anchor =>
    countOccurrences(content, anchor),
  );
  const patchedCounts = Object.values(PATCHED_ANCHORS).map(anchor =>
    countOccurrences(content, anchor),
  );
  const helperCount = countOccurrences(content, URL_HELPER);

  if (
    currentMarkerCount === 1 &&
    historicalMarkerCount === 0 &&
    helperCount === 1 &&
    patchedCounts.every(count => count === 1)
  ) {
    return content;
  }
  if (
    currentMarkerCount > 0 ||
    historicalMarkerCount > 0 ||
    helperCount > 0 ||
    patchedCounts.some(count => count > 0) ||
    originalCounts.some(count => count !== 1)
  ) {
    throw new Error(
      `${filePath}: historical, partial, or ambiguous OpenAI realtime transcription base URL patch detected`,
    );
  }

  let updated = replaceUnique(
    content,
    URL_CONSTANT,
    `${URL_CONSTANT}\n${URL_HELPER}`,
    `${filePath}: OpenAI realtime transcription URL helper`,
  );
  for (const key of Object.keys(ORIGINAL_ANCHORS)) {
    updated = replaceUnique(
      updated,
      ORIGINAL_ANCHORS[key],
      PATCHED_ANCHORS[key],
      `${filePath}: OpenAI realtime transcription ${key}`,
    );
  }
  return updated;
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargetShape(files);
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargetShape(files);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: OpenAI realtime transcription base URL support is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { MARKER, resolveOpenAIRealtimeTranscriptionUrl, transform },
};
