'use strict';

// Capability: isolate JustDo image and video OpenAI-compatible endpoint credentials from chat.
// Target: openclaw@2026.9.6 bundled OpenAI provider plugin entrypoint.
// Scope: two app-owned media provider aliases; native OpenAI chat/image/video behavior is unchanged.
// Safety: requests receive a cloned config view and never mutate or overwrite models.providers.openai.
// Remove when: upstream supports capability-scoped OpenAI-compatible provider configuration.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_ISOLATED_OPENAI_COMPATIBLE_MEDIA_PROVIDERS_V2026_9_6';
const PATCH_MARKER_PATTERN = /JUSTDO_ISOLATED_OPENAI_COMPATIBLE_MEDIA_PROVIDERS_V\d+_\d+_\d+/gu;

const ORIGINAL_IMAGE_REGISTRATION =
  '\t\tapi.registerImageGenerationProvider(buildOpenAIImageGenerationProvider({\n\t\t\tensureAuthProfileStore,\n\t\t\tlistProfilesForProvider,\n\t\t\tisProviderApiKeyConfigured\n\t\t}));';
const ORIGINAL_VIDEO_REGISTRATION =
  '\t\tapi.registerVideoGenerationProvider(buildOpenAIVideoGenerationProvider({ isProviderApiKeyConfigured }));';

const HELPER = [
  'const JUSTDO_IMAGE_CONFIG_PROVIDER_ID = "justdo-image-openai";',
  'const JUSTDO_VIDEO_CONFIG_PROVIDER_ID = "justdo-video-openai";',
  'function withJustDoMediaProviderConfig(cfg, providerId) {',
  '\tconst providerConfig = cfg?.models?.providers?.[providerId];',
  '\treturn {',
  '\t\t...cfg,',
  '\t\tmodels: {',
  '\t\t\t...cfg?.models,',
  '\t\t\tproviders: { ...cfg?.models?.providers, openai: providerConfig }',
  '\t\t}',
  '\t};',
  '}',
  'function buildJustDoImageGenerationProvider(auth) {',
  '\tconst provider = buildOpenAIImageGenerationProvider(auth);',
  '\treturn {',
  '\t\t...provider,',
  '\t\tisConfigured: (ctx) => Boolean(ctx.cfg?.models?.providers?.[JUSTDO_IMAGE_CONFIG_PROVIDER_ID]) && provider.isConfigured({ ...ctx, cfg: withJustDoMediaProviderConfig(ctx.cfg, JUSTDO_IMAGE_CONFIG_PROVIDER_ID) }),',
  '\t\tgenerateImage: (req) => provider.generateImage({ ...req, cfg: withJustDoMediaProviderConfig(req.cfg, JUSTDO_IMAGE_CONFIG_PROVIDER_ID) })',
  '\t};',
  '}',
  'function buildJustDoVideoGenerationProvider(auth) {',
  '\tconst provider = buildOpenAIVideoGenerationProvider(auth);',
  '\treturn {',
  '\t\t...provider,',
  '\t\tisConfigured: (ctx) => Boolean(ctx.cfg?.models?.providers?.[JUSTDO_VIDEO_CONFIG_PROVIDER_ID]) && provider.isConfigured({ ...ctx, cfg: withJustDoMediaProviderConfig(ctx.cfg, JUSTDO_VIDEO_CONFIG_PROVIDER_ID) }),',
  '\t\tgenerateVideo: (req) => provider.generateVideo({ ...req, cfg: withJustDoMediaProviderConfig(req.cfg, JUSTDO_VIDEO_CONFIG_PROVIDER_ID) })',
  '\t};',
  `}/*${MARKER}*/`,
].join('\n');

const PATCHED_IMAGE_REGISTRATION =
  '\t\tapi.registerImageGenerationProvider(buildJustDoImageGenerationProvider({ ensureAuthProfileStore, listProfilesForProvider, isProviderApiKeyConfigured }));';
const PATCHED_VIDEO_REGISTRATION =
  '\t\tapi.registerVideoGenerationProvider(buildJustDoVideoGenerationProvider({ isProviderApiKeyConfigured }));';

function targets(runtimeDir) {
  return findFilesContaining(
    runtimeDir,
    [
      '//#region extensions/openai/index.ts',
      'buildOpenAIImageGenerationProvider',
      'buildOpenAIVideoGenerationProvider',
      'api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);',
    ],
    { includeBundle: false },
  );
}

function assertTargetShape(files) {
  if (files.length !== 1) {
    throw new Error(`isolated media provider target count is ${files.length}, expected 1`);
  }
}

function transform(content, filePath) {
  const markers = [...content.matchAll(PATCH_MARKER_PATTERN)].map(match => match[0]);
  const currentMarkerCount = countOccurrences(content, MARKER);
  const historicalMarkerCount = markers.filter(marker => marker !== MARKER).length;
  const helperCount = countOccurrences(content, HELPER);
  const originalImageCount = countOccurrences(content, ORIGINAL_IMAGE_REGISTRATION);
  const originalVideoCount = countOccurrences(content, ORIGINAL_VIDEO_REGISTRATION);
  const patchedImageCount = countOccurrences(content, PATCHED_IMAGE_REGISTRATION);
  const patchedVideoCount = countOccurrences(content, PATCHED_VIDEO_REGISTRATION);

  if (
    currentMarkerCount === 1 &&
    historicalMarkerCount === 0 &&
    helperCount === 1 &&
    originalImageCount === 0 &&
    originalVideoCount === 0 &&
    patchedImageCount === 1 &&
    patchedVideoCount === 1
  ) {
    return content;
  }
  if (
    currentMarkerCount > 0 ||
    historicalMarkerCount > 0 ||
    helperCount > 0 ||
    patchedImageCount > 0 ||
    patchedVideoCount > 0 ||
    originalImageCount !== 1 ||
    originalVideoCount !== 1
  ) {
    throw new Error(
      `${filePath}: historical, partial, or ambiguous isolated media provider patch detected`,
    );
  }

  let updated = replaceUnique(
    content,
    '//#region extensions/openai/index.ts',
    `//#region extensions/openai/index.ts\n${HELPER}`,
    `${filePath}: isolated media provider helper`,
  );
  updated = replaceUnique(
    updated,
    ORIGINAL_IMAGE_REGISTRATION,
    PATCHED_IMAGE_REGISTRATION,
    `${filePath}: isolated image provider registration`,
  );
  return replaceUnique(
    updated,
    ORIGINAL_VIDEO_REGISTRATION,
    PATCHED_VIDEO_REGISTRATION,
    `${filePath}: isolated video provider registration`,
  );
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
      throw new Error(`${filePath}: isolated media provider support is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { MARKER, transform },
};
