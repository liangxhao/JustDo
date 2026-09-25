import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';

const { buildOpenClawPatchSetFingerprint } = require('../../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs') as {
  buildOpenClawPatchSetFingerprint: (repoRoot: string, version: string) => string;
};

type PatchModule = {
  applyPatch: (runtimeDir: string) => string[];
  verifyPatch: (runtimeDir: string) => void;
  __testing?: Record<string, unknown>;
};

const patchRoot = path.resolve('scripts/patches/v2026.9.2');
const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const patchFiles = fs
  .readdirSync(patchRoot)
  .filter(name => /^\d{3}-.*\.cjs$/u.test(name))
  .sort();
const patches = new Map(
  patchFiles.map(name => [name.slice(0, 3), require(path.join(patchRoot, name)) as PatchModule]),
);

const runtimeIsV2026_9_2 = (() => {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'),
    ) as { openclawVersion?: string };
    return info.openclawVersion === 'v2026.9.2';
  } catch {
    return false;
  }
})();

const runtimePatchSetIsCurrent = (() => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'), 'utf8'),
    ) as { patchSetSha256?: string; patches?: Array<{ file?: string }> };
    return JSON.stringify(
      (manifest.patches ?? []).map(patch => path.basename(patch.file ?? '')),
    ) === JSON.stringify(patchFiles) &&
      manifest.patchSetSha256 === buildOpenClawPatchSetFingerprint(path.resolve('.'), 'v2026.9.2');
  } catch {
    return false;
  }
})();

const findPatchedDistFiles = (prefix: string, marker: string): string[] => {
  const distRoot = path.join(runtimeRoot, 'dist');
  return fs
    .readdirSync(distRoot)
    .filter(name => name.startsWith(prefix) && name.endsWith('.js'))
    .map(name => path.join(distRoot, name))
    .filter(filePath => fs.readFileSync(filePath, 'utf8').includes(marker));
};

function buildTrustedLocalFileMediaFixture(): string {
  return [
    'const MANAGED_DOCUMENT_MIME_TYPES = new Set([',
    '  "application/json",',
    '  "application/msword",',
    '  "application/pdf"',
    ']);',
    'function normalizeMimeType(value) { return value?.toLowerCase(); }',
    'function mediaKindFromMime(value) { return value === "image/png" ? "image" : undefined; }',
    'function resolveManagedMediaKind(contentType) {',
    '  const normalized = normalizeMimeType(contentType);',
    '  const kind = mediaKindFromMime(normalized);',
    '  if (kind === "image" || kind === "audio" || kind === "video") return kind;',
    '  return normalized && MANAGED_DOCUMENT_MIME_TYPES.has(normalized) ? "document" : null;',
    '}',
    'function resolveLocalMediaPath(value) { return value.startsWith("file:") ? value : undefined; }',
    'function getSanitizedManagedImageAttachmentError(error) { return error; }',
    'function buildManagedMediaFailureBlock(params) {',
    '  return {',
    '    type: "attachment_error",',
    '    attachment: {',
    '      code: params.code,',
    '      kind: params.kind === "media" ? "document" : params.kind,',
    '      label: params.label,',
    '      ...params.mimeType ? { mimeType: params.mimeType } : {}',
    '    }',
    '  };',
    '}',
    'function validateManagedImageBuffer() {}',
    'function mimeTypeFromFilePath() { return "application/octet-stream"; }',
    'async function createManagedOutgoingMediaBlocks(params) {',
    '  const item = params.item;',
    '  const mediaUrl = item.url;',
    '  const unrelatedUrl = params.item.url;',
    '  void unrelatedUrl;',
    '  const localMediaPath = resolveLocalMediaPath(mediaUrl);',
    '  const savedOriginal = params.savedOriginal;',
    '  const hintedKind = "document";',
    '  const label = params.label ?? "generated-media";',
    '  const blocks = [];',
    '  try {',
    '    let savedOriginalContentType = savedOriginal.contentType ?? item.mimeType;',
    '    if (!savedOriginalContentType) throw new Error("Managed media attachment has no detectable content type");',
    '    const mediaKind = resolveManagedMediaKind(savedOriginalContentType);',
    '    if (!mediaKind) throw new Error("Managed media attachment has an unsupported content type");',
    '    return { mediaKind, contentType: savedOriginalContentType };',
    '  } catch (error) {',
    '    const sanitizedError = getSanitizedManagedImageAttachmentError(error, label, hintedKind);',
    '    if (params.continueOnPrepareError) {',
    '      blocks.push(buildManagedMediaFailureBlock({',
    '        code: "delivery-failed",',
    '        kind: hintedKind,',
    '        label,',
    '        mimeType: item.mimeType ?? mimeTypeFromFilePath(localMediaPath ?? mediaUrl)',
    '      }));',
    '      params.onPrepareError?.(sanitizedError);',
    '      return blocks;',
    '    }',
    '    throw sanitizedError;',
    '  }',
    '}',
    'function sendStatus() {}',
    'function buildAssistantMediaContentDisposition(filename) { return "attachment: " + filename; }',
    'function buildManagedMediaContentDisposition(value, contentType) {',
    '  const filename = value ?? "generated-media";',
    '  if (mediaKindFromMime(contentType) === "document") return buildAssistantMediaContentDisposition(filename);',
    '  return "inline: " + filename;',
    '}',
    'async function handleManagedOutgoingMediaHttpRequest() {}',
  ].join('\n');
}

function buildMediaProjectionFixture(): string {
  return [
    'function takeAssistantManagedMediaUrlsForDisplay(entry, role) {',
    '  const delivery = role === "assistant" ? entry.openclawDelivery : undefined;',
    '  const urls = Array.isArray(delivery?.mediaUrls)',
    '    ? delivery.mediaUrls.filter((url) => typeof url === "string")',
    '    : [];',
    '  if (!delivery || !Object.hasOwn(delivery, "mediaUrls")) {',
    '    return { changed: false, urls };',
    '  }',
    '  const projectedDelivery = { ...delivery };',
    '  delete projectedDelivery.mediaUrls;',
    '  if (Object.keys(projectedDelivery).length > 0) {',
    '    entry.openclawDelivery = projectedDelivery;',
    '  } else {',
    '    delete entry.openclawDelivery;',
    '  }',
    '  return { changed: true, urls };',
    '}',
  ].join('\n');
}

describe('OpenClaw v2026.9.2 capability patches', () => {
  test('requires the current live runtime proof when requested by CI', () => {
    if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED !== '1') return;
    expect(runtimeIsV2026_9_2).toBe(true);
    expect(runtimePatchSetIsCurrent).toBe(true);
  });

  test('contains exactly the twenty-five retained capability patches', () => {
    expect(patchFiles).toEqual([
      '001-managed-pip-config-environment.cjs',
      '002-windows-mcp-package-runner.cjs',
      '003-windows-chrome-mcp-launch.cjs',
      '005-final-system-prompt-replacements.cjs',
      '006-agent-request-metadata.cjs',
      '007-request-purpose-metadata.cjs',
      '008-app-startup-task-recovery-boundary.cjs',
      '009-memory-force-reembed-opt-in.cjs',
      '013-goal-resume-after-pause.cjs',
      '014-assistant-display-block-replay.cjs',
      '015-trusted-local-file-media.cjs',
      '016-offline-official-plugin-catalog.cjs',
      '017-segmented-live-progress-snapshot.cjs',
      '018-mixed-tool-commentary-order.cjs',
      '019-disable-configured-plugin-auto-install.cjs',
      '020-openai-realtime-transcription-base-url.cjs',
      '021-isolated-openai-compatible-media-providers.cjs',
      '022-justdo-reset-display-history.cjs',
      '023-managed-session-fork-target-key.cjs',
      '024-acp-allowed-agents-hot-reload.cjs',
      '025-mxc-external-skill-paths.cjs',
      '026-private-untrusted-context.cjs',
      '027-shared-session-access-registry.cjs',
      '028-admin-session-cwd.cjs',
      '030-cron-session-permission.cjs',
    ]);
  });

  test('atomically includes an assistant entry only in an admin-selected managed fork', () => {
    const testing = patches.get('023')?.__testing as {
      MARKERS: { schema: string; handler: string; accessor: string };
      transformAccessor: (content: string, filePath: string) => string;
      transformHandler: (content: string, filePath: string) => string;
      transformSchema: (content: string, filePath: string) => string;
    };
    const schema = [
      'const SessionsRewindParamsSchema = closedObject({ entryId: NonEmptyString });',
      'const SessionsForkParamsSchema = closedObject({',
      '\tsessionKey: NonEmptyString,',
      '\tagentId: Type.Optional(NonEmptyString),',
      '\tentryId: NonEmptyString',
      '});',
      'const SessionsForkResultSchema = closedObject({ sessionKey: NonEmptyString });',
    ].join('\n');
    const handler = [
      'async function mutateSessionAtMessage(options, action) {',
      '\tconst { params, respond, context, client } = options;',
      '\tconst cfg = context.getRuntimeConfig();',
      '\tconst current = loadAccessorSessionEntryForGatewayTarget({ key: params.sessionKey, cfg });',
      '\tconst lifecycleIdentities = [params.sessionKey, current.canonicalKey];',
      '\tconst upstreamLink = readSessionUpstreamLink(current.canonicalKey, current.target.agentId);',
      '\tconst targetKey = action === "fork" ? buildDashboardSessionKey(current.target.agentId, { incognito: current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey) }) : current.canonicalKey;',
      '\tconst mutationParams = { sessionKey: current.canonicalKey };',
      '\treturn forkSessionAtMessage({ ...mutationParams, entryId, targetKey, creation: resolveOperatorSessionCreation(client) });',
      '}',
    ].join('\n');
    const accessor = [
      'function mutateSqliteSessionAtMessage(params, mode, expectedState) {',
      '\treturn mutateSqliteSessionAtMessageInTransaction(database, resolved, {',
      '\t\tentryId: params.entryId,',
      '\t\tmode,',
      '\t});',
      '}',
      'function mutateSqliteSessionAtMessageInTransaction(database, resolved, params) {',
      '\tconst events = loadTranscriptEventsFromDatabase(database, currentEntry.sessionId);',
      '\tconst cut = params.mode === "switch" ? void 0 : resolveMessageCut(events, params.entryId);',
      '\treturn cut;',
      '}',
      'function resolveMessageCut(events, entryId) {',
      '\tconst tree = scanSessionTranscriptTree(events);',
      '\tconst target = tree.byId.get(entryId);',
      '\tif (!target) return { status: "missing-entry" };',
      '\tconst record = asOptionalRecord(target.entry);',
      '\tconst message = asOptionalRecord(record?.message);',
      '\tif (record?.type !== "message" || message?.role !== "user") return { status: "not-user-message" };',
      '\tconst activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);',
      '\tconst targetIndex = activePath.findIndex(node => node.id === entryId);',
      '\tconst prefix = [];',
      '\tfor (const node of activePath.slice(0, targetIndex)) {',
      '\t\tconst entry = asOptionalRecord(node.entry);',
      '\t\tprefix.push(entry && entry.parentId !== node.parentId ? {',
      '\t\t\t...entry,',
      '\t\t\tparentId: node.parentId,',
      '\t\t} : node.entry);',
      '\t}',
      '\tconst editorAttachments = extractEditorAttachments(message.content);',
      '\tconst editorMediaRefs = extractEditorMediaRefs(message);',
      '\treturn {',
      '\t\tstatus: "cut",',
      '\t\teditorText: extractEditorText(message.content),',
      '\t\t...editorAttachments ? { editorAttachments } : {},',
      '\t\t...editorMediaRefs ? { editorMediaRefs } : {},',
      '\t\tparentId: target.parentId,',
      '\t\tprefix,',
      '\t};',
      '}',
    ].join('\n');

    const patchedSchema = testing.transformSchema(schema, 'sessions-schema.js');
    expect(patchedSchema).toContain('targetKey: Type.Optional(NonEmptyString)');
    expect(patchedSchema).toContain('includeEntry: Type.Optional(Type.Boolean())');
    expect(patchedSchema).toContain('entryId: NonEmptyString,\n\ttargetKey:');
    expect(patchedSchema).toContain(`/*${testing.MARKERS.schema}*/`);
    expect(() => new vm.Script(patchedSchema)).not.toThrow();
    expect(testing.transformSchema(patchedSchema, 'sessions-schema.js')).toBe(patchedSchema);
    const bundledSchema = patchedSchema
      .replace('const SessionsForkParamsSchema', 'SessionsForkParamsSchema')
      .replaceAll('Type.', 'typebox_exports.')
      .replace(`/*${testing.MARKERS.schema}*/`, '');
    expect(testing.transformSchema(bundledSchema, 'gateway-bundle.mjs')).toBe(bundledSchema);

    const patchedHandler = testing.transformHandler(handler, 'sessions-rewind.js');
    expect(patchedHandler).toContain('sessions.fork targetKey requires operator.admin');
    expect(patchedHandler).toContain('`agent:${current.target.agentId}:justdo:`');
    expect(patchedHandler).toContain('sessions.fork targetKey already exists');
    expect(patchedHandler).toContain('sessions.fork includeEntry requires targetKey');
    expect(patchedHandler).toContain('sessions.fork includeEntry is unavailable for linked sessions');
    expect(patchedHandler).toContain('includeEntry: requestedForkIncludeEntry');
    expect(patchedHandler).toContain(
      '...(requestedForkTargetKey ? [requestedForkTargetKey] : [])',
    );
    expect(patchedHandler).toContain(
      'current.canonicalKey,\n\t\t...(requestedForkTargetKey ? [requestedForkTargetKey] : [])',
    );
    expect(patchedHandler).toContain('requestedForkTargetKey || buildDashboardSessionKey');
    expect(patchedHandler).toContain(`/*${testing.MARKERS.handler}*/`);
    expect(() => new vm.Script(patchedHandler)).not.toThrow();
    expect(testing.transformHandler(patchedHandler, 'sessions-rewind.js')).toBe(patchedHandler);

    const patchedAccessor = testing.transformAccessor(accessor, 'session-accessor.js');
    expect(patchedAccessor).toContain('includeEntry: params.includeEntry');
    expect(patchedAccessor).toContain(
      'params.mode === "fork" && params.includeEntry === true',
    );
    expect(patchedAccessor).toContain(
      'targetIndex + (includeTargetEntry ? 1 : 0)',
    );
    expect(patchedAccessor).toContain(
      'message.stopReason == null || ["stop", "length"].includes(message.stopReason)',
    );
    expect(patchedAccessor).toContain(
      'includeTargetEntry ? undefined : extractEditorText(message.content)',
    );
    expect(patchedAccessor).toContain('parentId: includeTargetEntry ? target.id : target.parentId');
    expect(patchedAccessor).toContain(`/*${testing.MARKERS.accessor}*/`);
    expect(testing.transformAccessor(patchedAccessor, 'session-accessor.js')).toBe(
      patchedAccessor,
    );
    const bundledAccessor = patchedAccessor
      .replaceAll('undefined', 'void 0')
      .replace(`/*${testing.MARKERS.accessor}*/`, '');
    expect(testing.transformAccessor(bundledAccessor, 'gateway-bundle.mjs')).toBe(
      bundledAccessor,
    );
  });

  test('routes OpenAI realtime transcription through its configured base URL', () => {
    const testing = patches.get('020')?.__testing as {
      MARKER: string;
      resolveOpenAIRealtimeTranscriptionUrl: (baseUrl?: string) => string;
      transform: (content: string, filePath: string) => string;
    };
    const source = [
      'const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";',
      'function normalizeProviderConfig(config) {',
      '\tconst raw = config;',
      '\treturn {',
      '\t\tapiKey: raw?.apiKey,',
      '\t\tlanguage: normalizeOptionalString(raw?.language),',
      '\t};',
      '}',
      'function createOpenAIRealtimeTranscriptionSession(config, runtime) {',
      '\treturn runtime.createRealtimeTranscriptionWebSocketSession({',
      '\t\tproviderId: "openai",',
      '\t\tcallbacks: config,',
      '\t\turl: OPENAI_REALTIME_TRANSCRIPTION_URL,',
      '\t\theaders: async () => runtime.resolveProviderRequestHeaders({',
      '\t\t\t\tbaseUrl: OPENAI_REALTIME_TRANSCRIPTION_URL,',
      '\t\t}),',
      '\t});',
      '}',
      'function buildOpenAIRealtimeTranscriptionProvider(runtime) {',
      '\treturn {',
      '\t\tcreateSession: (req) => {',
      '\t\t\tconst config = normalizeProviderConfig(req.providerConfig);',
      '\t\t\treturn createOpenAIRealtimeTranscriptionSession({',
      '\t\t\t\t...req,',
      '\t\t\t\tapiKey: config.apiKey,',
      '\t\t\t\tlanguage: config.language,',
      '\t\t\t}, runtime);',
      '\t\t}',
      '\t};',
      '}',
    ].join('\n');

    const patched = testing.transform(source, 'realtime-transcription-provider-factory.js');

    expect(patched).toContain(`/*${testing.MARKER}*/`);
    expect(patched).toContain('baseUrl: normalizeOptionalString(raw?.baseUrl)');
    expect(patched).toContain(
      'const transcriptionUrl = resolveOpenAIRealtimeTranscriptionUrl(config.baseUrl)',
    );
    expect(patched).toContain('url: transcriptionUrl');
    expect(patched).toContain('baseUrl: transcriptionUrl');
    expect(patched).toContain('baseUrl: config.baseUrl');
    expect(testing.transform(patched, 'realtime-transcription-provider-factory.js')).toBe(patched);
    expect(testing.resolveOpenAIRealtimeTranscriptionUrl('http://speech.internal:8000/v1')).toBe(
      'ws://speech.internal:8000/v1/realtime?intent=transcription',
    );
    expect(
      testing.resolveOpenAIRealtimeTranscriptionUrl(
        'https://speech.internal/v1/realtime?tenant=justdo',
      ),
    ).toBe('wss://speech.internal/v1/realtime?tenant=justdo&intent=transcription');
  });

  test('keeps routine official plugin catalog reads offline', () => {
    const testing = patches.get('016')?.__testing as {
      MARKER: string;
      transform: (content: string, filePath: string) => string;
    };
    const source = [
      'async function loadOfficialCatalog() {',
      '  const cache = getManagedPluginCache();',
      '  if (!cache.officialCatalog) {',
      '    const promise = Promise.resolve().then(() => loadConfiguredHostedOfficialExternalPluginCatalogEntries());',
      '    cache.officialCatalog = promise;',
      '  }',
      '  return await cache.officialCatalog;',
      '}',
    ].join('\n');

    const patched = testing.transform(source, 'management-catalog.js');
    expect(patched).toContain(
      `loadConfiguredHostedOfficialExternalPluginCatalogEntries({ offline: true })/*${testing.MARKER}*/`,
    );
    expect(testing.transform(patched, 'management-catalog.js')).toBe(patched);
    const bundled = testing.transform(source, 'gateway-bundle.mjs');
    expect(bundled).toContain(
      'loadConfiguredHostedOfficialExternalPluginCatalogEntries({ offline: true })',
    );
    expect(bundled).not.toContain(testing.MARKER);
    expect(testing.transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    const generatedFromPatchedSource = patched.replace(
      `)/*${testing.MARKER}*/`,
      `)\n      /*${testing.MARKER}*/`,
    );
    const normalizedBundle = testing.transform(
      generatedFromPatchedSource,
      'gateway-bundle.mjs',
    );
    expect(normalizedBundle).toContain(
      'loadConfiguredHostedOfficialExternalPluginCatalogEntries({ offline: true })',
    );
    expect(normalizedBundle).not.toContain(testing.MARKER);
    expect(testing.transform(normalizedBundle, 'gateway-bundle.mjs')).toBe(normalizedBundle);
    expect(() =>
      testing.transform(
        generatedFromPatchedSource.replace('V2026_9_2', 'V2026_8_2'),
        'gateway-bundle.mjs',
      ),
    ).toThrow('historical or partial');
    expect(() =>
      testing.transform(
        patched.replace(testing.MARKER, testing.MARKER.replace('9_2', '8_2')),
        'historical-management-catalog.js',
      ),
    ).toThrow('historical or partial');
  });

  test('disables configured plugin package repair while preserving install records', async () => {
    const testing = patches.get('019')?.__testing as {
      MARKER: string;
      transform: (content: string, filePath: string) => string;
    };
    const source = [
      'async function repairMissingPluginInstallsWithLease(params) {',
      '  const env4 = params.env ?? process.env;',
      '  const { records } = await resolveConfiguredPluginInstallContext({ cfg: params.cfg, env: env4 });',
      '  await updateNpmInstalledPlugins(records);',
      '  await writePersistedInstalledPluginIndexInstallRecords(records, { config: params.cfg, env: env4 });',
      '  return { changes: ["installed"], warnings: [], records };',
      '}',
    ].join('\n');

    const patched = testing.transform(source, 'missing-configured-plugin-install.js');
    expect(patched).toContain(
      `return { changes: [], warnings: [], records: persistedRecords };/*${testing.MARKER}*/`,
    );
    expect(patched).not.toContain('updateNpmInstalledPlugins(records)');
    expect(testing.transform(patched, 'missing-configured-plugin-install.js')).toBe(patched);

    const persistedRecords = { opencode: { source: 'npm' } };
    const resolveConfiguredPluginInstallContext = vi.fn(
      async (params: { baselineRecords?: Record<string, unknown> }) => ({
        records: {},
        persistedRecords: params.baselineRecords ?? persistedRecords,
      }),
    );
    const writePersistedInstalledPluginIndexInstallRecords = vi.fn();
    const repair = new Function(
      'resolveConfiguredPluginInstallContext',
      'writePersistedInstalledPluginIndexInstallRecords',
      `${patched}; return repairMissingPluginInstallsWithLease;`,
    )(
      resolveConfiguredPluginInstallContext,
      writePersistedInstalledPluginIndexInstallRecords,
    ) as (params: object) => Promise<{
      changes: string[];
      warnings: string[];
      records: Record<string, unknown>;
    }>;
    await expect(
      repair({ cfg: {}, pluginIds: new Set(['opencode']), channelIds: new Set() }),
    ).resolves.toEqual({
      changes: [],
      warnings: [],
      records: persistedRecords,
    });
    expect(writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();

    const beforePersistentEffect = vi.fn();
    const baselineRecords = { synced: { source: 'npm' } };
    await expect(
      repair({
        cfg: {},
        pluginIds: new Set(),
        channelIds: new Set(),
        baselineRecords,
        beforePersistentEffect,
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [],
      records: baselineRecords,
    });
    expect(beforePersistentEffect).toHaveBeenCalledOnce();
    expect(writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      baselineRecords,
      { config: {}, env: process.env },
    );

    const bundled = testing.transform(source, 'gateway-bundle.mjs');
    expect(bundled).toContain(
      'return { changes: [], warnings: [], records: persistedRecords };',
    );
    expect(bundled).not.toContain(testing.MARKER);
    expect(testing.transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);

    const esbuildRenamedBundle = bundled
      .replace('const env = params.env', 'const env4 = params.env')
      .replace(/\benv,\n/g, 'env: env4,\n')
      .replace(/\benv\n/g, 'env: env4\n');
    expect(esbuildRenamedBundle).toContain('env: env4');
    expect(testing.transform(esbuildRenamedBundle, 'gateway-bundle.mjs')).toBe(
      esbuildRenamedBundle,
    );

    const generatedBundle = buildSync({
      stdin: {
        contents: [
          'async function resolveConfiguredPluginInstallContext() { return { persistedRecords: {} }; }',
          'async function writePersistedInstalledPluginIndexInstallRecords() {}',
          patched,
          'export { repairMissingPluginInstallsWithLease };',
        ].join('\n'),
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    }).outputFiles[0].text;
    const normalizedGeneratedBundle = testing.transform(
      generatedBundle,
      'gateway-bundle.mjs',
    );
    expect(normalizedGeneratedBundle).not.toContain(testing.MARKER);
    expect(testing.transform(normalizedGeneratedBundle, 'gateway-bundle.mjs')).toBe(
      normalizedGeneratedBundle,
    );

    expect(() =>
      testing.transform(
        patched.replace(testing.MARKER, testing.MARKER.replace('9_2', '8_2')),
        'historical-missing-configured-plugin-install.js',
      ),
    ).toThrow('historical or partial');
    expect(() =>
      testing.transform(
        [
          `const unrelated = () => ({ changes: [], warnings: [], records: persistedRecords });/*${testing.MARKER}*/`,
          source,
        ].join('\n'),
        'partial-missing-configured-plugin-install.js',
      ),
    ).toThrow('historical or partial');
    expect(() =>
      testing.transform(
        patched.replace(
          '  if (params.baselineRecords) {',
          '  await updateNpmInstalledPlugins({});\n  if (params.baselineRecords) {',
        ),
        'side-effect-missing-configured-plugin-install.js',
      ),
    ).toThrow('historical or partial');
  });

  test('applies configured plugin auto-install policy to both source chunks and the Gateway bundle', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-plugin-auto-install-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const workerRoot = path.join(distRoot, 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const source = [
      'async function repairMissingPluginInstallsWithLease(params) {',
      '  const env = params.env ?? process.env;',
      '  const { records } = await resolveConfiguredPluginInstallContext({ cfg: params.cfg, env });',
      '  await updateNpmInstalledPlugins(records);',
      '  await writePersistedInstalledPluginIndexInstallRecords(records, { config: params.cfg, env });',
      '  return { changes: ["installed"], warnings: [], records };',
      '}',
    ].join('\n');
    const sourcePath = path.join(distRoot, 'missing-configured-plugin-install.js');
    const workerPath = path.join(workerRoot, 'worker.mjs');
    const bundlePath = path.join(fixtureRoot, 'gateway-bundle.mjs');

    try {
      fs.writeFileSync(sourcePath, source);
      fs.writeFileSync(workerPath, source);
      const patch = patches.get('019')!;
      expect(patch.applyPatch(fixtureRoot)).toEqual([
        path.join('dist', 'missing-configured-plugin-install.js'),
        path.join('dist', 'worker', 'worker.mjs'),
      ]);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      fs.writeFileSync(bundlePath, source);
      expect(patch.applyPatch(fixtureRoot)).toEqual(['gateway-bundle.mjs']);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects historical v2026.8.2 contracts in retained patch families', () => {
    const mcpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mcp-marker-'));
    const promptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-prompt-marker-'));
    try {
      const mcpDist = path.join(mcpRoot, 'dist');
      fs.mkdirSync(mcpDist, { recursive: true });
      const mcpSource = [
        'throw new Error("OpenClawStdioClientTransport already started");',
        'OpenClawStdioClientTransport = class {',
        '  start() {',
        '    const launchEnv = {};',
        '    const transport = prepareOomScoreAdjustedSpawn(this.serverParams.command, this.serverParams.args ?? [], { env: launchEnv });',
        '    return { transport, windowsHide: process.platform === "win32" };',
        '  }',
        '};',
      ].join('\n');
      const mcpFiles = [path.join(mcpDist, 'mcp-one.js'), path.join(mcpDist, 'mcp-two.js')];
      for (const filePath of mcpFiles) fs.writeFileSync(filePath, mcpSource);
      const mcpPatch = patches.get('002')!;
      expect(mcpPatch.applyPatch(mcpRoot)).toHaveLength(2);
      expect(() => mcpPatch.verifyPatch(mcpRoot)).not.toThrow();
      fs.writeFileSync(
        mcpFiles[0],
        fs
          .readFileSync(mcpFiles[0], 'utf8')
          .replace('JUSTDO_WINDOWS_MCP_PACKAGE_RUNNER_V2026_9_2', 'JUSTDO_WINDOWS_MCP_PACKAGE_RUNNER_V2026_8_2'),
      );
      expect(() => mcpPatch.verifyPatch(mcpRoot)).toThrow('historical or partial');

      const promptDist = path.join(promptRoot, 'dist');
      fs.mkdirSync(promptDist, { recursive: true });
      const promptPath = path.join(promptDist, 'embedded-attempt.js');
      fs.writeFileSync(
        promptPath,
        [
          'async function prepareEmbeddedAttemptPromptAssembly(input) {',
          '  const modelAwareSystemPrompt = isSettledTurnFinalization ? systemPromptText : systemPromptText;',
          '\tif (modelAwareSystemPrompt !== systemPromptText) setSystemPrompt(modelAwareSystemPrompt);',
          '\tlet promptCacheChangesForTurn = null;',
          '  if (input.cache.observabilityEnabled) return promptCacheChangesForTurn;',
          '}',
        ].join('\n'),
      );
      const promptPatch = patches.get('005')!;
      expect(promptPatch.applyPatch(promptRoot)).toEqual([path.join('dist', 'embedded-attempt.js')]);
      expect(() => promptPatch.verifyPatch(promptRoot)).not.toThrow();
      fs.writeFileSync(
        promptPath,
        fs
          .readFileSync(promptPath, 'utf8')
          .replace('JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS_V2026_9_2', 'JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS_V2026_8_2'),
      );
      expect(() => promptPatch.verifyPatch(promptRoot)).toThrow('historical or partial');

      const metadata = patches.get('006')?.__testing as {
        CONTRACT: string;
      };
      const metadataPatch = patches.get('006') as PatchModule & {
        patchChatRegistration: (content: string, filePath: string) => string;
        patchSchema: (content: string, filePath: string) => string;
      };
      const schema = metadataPatch.patchSchema(
        'systemInputProvenance: T.Optional(InputProvenanceSchema), systemProvenanceReceipt: receipt',
        'chat-schema.js',
      );
      expect(schema).toContain(metadata.CONTRACT);
      expect(schema).toContain('justdoHideUserMessage: T.Optional(T.Boolean())');
      expect(() =>
        metadataPatch.patchSchema(
          schema.replace(/justdoHideUserMessage:[^\n]+\n/, ''),
          'partial-chat-schema.js',
        ),
      ).toThrow('historical or partial');
      expect(() =>
        metadataPatch.patchSchema(
          schema.replace(metadata.CONTRACT, metadata.CONTRACT.replace('9_2', '8_2')),
          'historical-chat-schema.js',
        ),
      ).toThrow('historical or partial');

      const registration = metadataPatch.patchChatRegistration(
        [
          'const userTurn = createGatewayChatUserTurnController({',
          '  admission: admitted.value,',
          '  transcript: options?.transcript,',
          '});',
          'context.addChatRun(clientRunId, { sessionKey, runId: clientRunId });',
        ].join('\n'),
        'chat-send-handler.js',
      );
      expect(registration).toContain(
        'p.justdoHideUserMessage === true && client?.internal?.isLocalClient === true',
      );
      expect(registration).toContain(
        'client?.connect?.client?.id === "gateway-client" && client?.connect?.client?.mode === "backend"',
      );
      expect(registration).toContain(
        'client?.connect?.scopes?.includes("operator.admin") ? { ...options?.transcript, display: false } : options?.transcript',
      );
      expect(metadataPatch.patchChatRegistration(registration, 'chat-send-handler.js')).toBe(
        registration,
      );

      const privateContextPatch = patches.get('026') as PatchModule & {
        patchAgentContext: (content: string, filePath: string) => string;
        patchSchema: (content: string, filePath: string) => string;
      };
      const privateContextSchema = privateContextPatch.patchSchema(
        [
          'message: T.String(),',
          'justdoHideUserMessage: T.Optional(T.Boolean()),',
          '// JUSTDO_AGENT_REQUEST_METADATA_AND_HIDDEN_TURNS_V2026_9_2: chat send schema',
          'systemProvenanceReceipt: receipt',
        ].join('\n'),
        'chat-schema.js',
      );
      expect(privateContextSchema).toContain(
        'justdoUntrustedContext: T.Optional(T.String({ maxLength: 24000 }))',
      );
      expect(privateContextPatch.patchSchema(privateContextSchema, 'chat-schema.js')).toBe(
        privateContextSchema,
      );
      expect(
        privateContextPatch.patchSchema(
          privateContextSchema.replace('maxLength: 24000', 'maxLength: 24e3'),
          'gateway-bundle.mjs',
        ),
      ).toContain('maxLength: 24e3');
      expect(() =>
        privateContextPatch.patchSchema(
          privateContextSchema.replace('maxLength: 24000', 'maxLength: 48000'),
          'historical-chat-schema.js',
        ),
      ).toThrow('historical or partial');

      const privateContextSource = privateContextPatch.patchAgentContext(
        [
          'function prepareChatSendUserTurn(params) {',
          '  const { request, attachments } = params;',
          '  const messageForAgent = request.systemProvenanceReceipt ? [request.systemProvenanceReceipt, attachments.parsedMessage].filter(Boolean).join("\\n\\n") : attachments.parsedMessage;',
          '  return messageForAgent;',
          '}',
        ].join('\n'),
        'chat-send-handler.js',
      );
      const evaluatePrivateContext = (client: Record<string, unknown>) =>
        vm.runInNewContext(
          `${privateContextSource}; prepareChatSendUserTurn({ client, request: { p: { justdoUntrustedContext: "browser state" } }, attachments: { parsedMessage: "user text" } })`,
          { client },
        ) as string;
      expect(
        evaluatePrivateContext({
          internal: { isLocalClient: true },
          connect: {
            client: { id: 'gateway-client', mode: 'backend' },
            scopes: ['operator.admin'],
          },
        }),
      ).toBe('browser state\n\nuser text');
      expect(evaluatePrivateContext({})).toBe('user text');
      expect(() =>
        privateContextPatch.patchAgentContext(
          privateContextSource.replace(
            'params.client?.internal?.isLocalClient === true',
            'params.client?.auth?.operatorRoleActor === "local"',
          ),
          'historical-chat-send-handler.js',
        ),
      ).toThrow('historical or partial');

      const purpose = patches.get('007')?.__testing as {
        COMPACTION_BLOCK: string;
        CONTRACT: string;
      };
      const purposePatch = patches.get('007') as PatchModule & {
        patchCompaction: (content: string, runtimeDir: string, filePath: string) => string;
      };
      expect(
        purposePatch.patchCompaction(purpose.COMPACTION_BLOCK, '.', 'compaction.js'),
      ).toBe(purpose.COMPACTION_BLOCK);
      expect(() =>
        purposePatch.patchCompaction(
          purpose.COMPACTION_BLOCK.replace(
            purpose.CONTRACT,
            purpose.CONTRACT.replace('9_2', '8_2'),
          ),
          '.',
          'historical-compaction.js',
        ),
      ).toThrow('historical or partial');
    } finally {
      fs.rmSync(mcpRoot, { recursive: true, force: true });
      fs.rmSync(promptRoot, { recursive: true, force: true });
    }
  });

  test('excludes assistant display blocks before tool-call ID normalization', () => {
    const testing = patches.get('014')?.__testing as {
      MARKER: string;
      transform: (content: string, filePath: string) => string;
    };
    const source = [
      'function transformTransportMessages(messages, model, normalizeToolCallId, options) {',
      '  void normalizeToolCallId;',
      '  return messages.map((message) => {',
      '    if (message.role !== "assistant") return message;',
      '    const content = [];',
      '    for (const block of message.content) {',
      '      if (block.type === "thinking" || block.type === "text") {',
      '        content.push(block);',
      '        continue;',
      '      }',
      '      if (block.type !== "toolCall") {',
      '        content.push(block);',
      '        continue;',
      '      }',
      '      if (options?.preserveCrossModelToolCallThoughtSignature) void model;',
      '      if (options?.normalizeSameModelToolCallIds) void model;',
      '      content.push({ ...block, id: block.id.trim() });',
      '    }',
      '    return { ...message, content };',
      '  });',
      '}',
    ].join('\n');
    const patched = testing.transform(source, 'worker.mjs');
    expect(patched).toContain(`if (block.type !== "toolCall") continue;/*${testing.MARKER}*/`);
    expect(patched.indexOf('block.type !== "toolCall"')).toBeLessThan(
      patched.indexOf('block.id.trim()'),
    );
    expect(testing.transform(patched, 'worker.mjs')).toBe(patched);

    const bundle = testing.transform(source, 'gateway-bundle.mjs');
    expect(bundle).toContain('if (block.type !== "toolCall") continue;');
    expect(bundle).not.toContain(testing.MARKER);
    expect(testing.transform(bundle, 'gateway-bundle.mjs')).toBe(bundle);

    const replay = new Function(`${patched}\nreturn transformTransportMessages;`)() as (
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>,
      model: object,
      normalizeToolCallId: undefined,
      options: object,
    ) => Array<{ content: Array<Record<string, unknown>> }>;
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'done' },
          { type: 'attachment_error', attachment: { error: 'missing' } },
          { type: 'toolCall', id: ' call-1 ', name: 'get_goal' },
        ],
      },
    ];
    expect(replay(messages, {}, undefined, {})[0].content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'toolCall', id: 'call-1', name: 'get_goal' },
    ]);
    expect(messages[0].content).toContainEqual({
      type: 'attachment_error',
      attachment: { error: 'missing' },
    });

    expect(() =>
      testing.transform(patched.replace(`/*${testing.MARKER}*/`, ''), 'worker.mjs'),
    ).toThrow('historical or partial');
    expect(() =>
      testing.transform(
        patched.replace('block.type !== "toolCall"', 'block.type !== "attachment_error"'),
        'worker.mjs',
      ),
    ).toThrow('historical or partial');
  });

  test('applies and verifies assistant display-block replay against a portable runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-display-replay-patch-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const workerRoot = path.join(distRoot, 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const source = [
      'function transformTransportMessages(messages, model, normalizeToolCallId, options) {',
      '  const content = [];',
      '  for (const block of messages) {',
      '    if (block.type !== "toolCall") { content.push(block); continue; }',
      '    if (options?.preserveCrossModelToolCallThoughtSignature) void model;',
      '    if (options?.normalizeSameModelToolCallIds) void normalizeToolCallId;',
      '    content.push(block);',
      '  }',
      '  return content;',
      '}',
    ].join('\n');
    const sourcePath = path.join(distRoot, 'ai-transport-runtime-host.js');
    const workerPath = path.join(workerRoot, 'worker.mjs');
    const bundlePath = path.join(fixtureRoot, 'gateway-bundle.mjs');

    try {
      fs.writeFileSync(sourcePath, source);
      fs.writeFileSync(workerPath, source);
      fs.writeFileSync(bundlePath, source);
      const patch = patches.get('014')!;
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(3);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      fs.writeFileSync(
        workerPath,
        fs
          .readFileSync(workerPath, 'utf8')
          .replace(/\/\*JUSTDO_ASSISTANT_DISPLAY_BLOCK_REPLAY_V2026_9_2\*\//u, ''),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(!runtimeIsV2026_9_2)(
    'matches assistant display-block replay in the worker and Gateway bundle shapes',
    () => {
      const testing = patches.get('014')?.__testing as {
        transform: (content: string, filePath: string) => string;
      };
      const files = [
        ...findPatchedDistFiles(
          'ai-transport-runtime-host-',
          'JUSTDO_ASSISTANT_DISPLAY_BLOCK_REPLAY_V2026_9_2',
        ),
        path.join(runtimeRoot, 'dist', 'worker', 'worker.mjs'),
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ];
      expect(files).toHaveLength(3);
      for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const transformed = testing.transform(content, filePath);
        expect(transformed).toContain('type !== "toolCall"');
        expect(testing.transform(transformed, filePath)).toBe(transformed);
      }
    },
    120_000,
  );

  test('delivers trusted generic files without extending MEDIA failure metadata', async () => {
    const testing = patches.get('015')?.__testing as {
      MARKER: string;
      transform: (content: string, filePath: string) => string;
    };
    const source = buildTrustedLocalFileMediaFixture();
    const patched = testing.transform(source, 'managed-media.js');
    expect(patched).toContain('"application/octet-stream"');
    expect(patched).toContain(`/*${testing.MARKER}*/`);
    expect(patched).toContain('resolveManagedMediaKind(contentType)');
    expect(testing.transform(patched, 'managed-media.js')).toBe(patched);

    const behavior = new Function(
      `${patched}\nreturn { createManagedOutgoingMediaBlocks, buildManagedMediaContentDisposition };`,
    )() as {
      createManagedOutgoingMediaBlocks: (params: {
        item: { url: string; trustedLocal?: boolean; mimeType?: string };
        savedOriginal: { contentType?: string };
        label?: string;
        continueOnPrepareError?: boolean;
        onPrepareError?: (error: Error) => void;
      }) => Promise<
        { mediaKind: string; contentType: string } | Array<Record<string, unknown>>
      >;
      buildManagedMediaContentDisposition: (filename: string, contentType: string) => string;
    };
    await expect(
      behavior.createManagedOutgoingMediaBlocks({
        item: { url: 'file:quicksort_demo\\quicksort_v1.py', trustedLocal: true },
        savedOriginal: {},
      }),
    ).resolves.toEqual({ mediaKind: 'document', contentType: 'application/octet-stream' });
    await expect(
      behavior.createManagedOutgoingMediaBlocks({
        item: { url: 'https://example.test/script.unknown' },
        savedOriginal: {},
      }),
    ).rejects.toThrow('no detectable content type');
    await expect(
      behavior.createManagedOutgoingMediaBlocks({
        item: { url: 'file:script.unknown' },
        savedOriginal: {},
      }),
    ).rejects.toThrow('no detectable content type');
    await expect(
      behavior.createManagedOutgoingMediaBlocks({
        item: { url: 'https://example.test/archive.bin' },
        savedOriginal: { contentType: 'application/octet-stream' },
      }),
    ).rejects.toThrow('unsupported content type');
    const sourcePath = 'quicksort_demo\\quicksort_1_lomuto.py';
    await expect(
      behavior.createManagedOutgoingMediaBlocks({
        item: { url: sourcePath },
        savedOriginal: {},
        label: 'quicksort_1_lomuto.py',
        continueOnPrepareError: true,
      }),
    ).resolves.toEqual([
      {
        type: 'attachment_error',
        attachment: {
          code: 'delivery-failed',
          kind: 'document',
          label: 'quicksort_1_lomuto.py',
          mimeType: 'application/octet-stream',
        },
      },
    ]);
    expect(
      behavior.buildManagedMediaContentDisposition('script.unknown', 'application/octet-stream'),
    ).toBe('attachment: script.unknown');
    expect(behavior.buildManagedMediaContentDisposition('image.png', 'image/png')).toBe(
      'inline: image.png',
    );

    const bundle = testing.transform(source, 'gateway-bundle.mjs');
    expect(bundle).not.toContain(testing.MARKER);
    expect(testing.transform(bundle, 'gateway-bundle.mjs')).toBe(bundle);
    const bundleFromPatchedSource = testing.transform(patched, 'gateway-bundle.mjs');
    expect(bundleFromPatchedSource).not.toContain(testing.MARKER);
    expect(testing.transform(bundleFromPatchedSource, 'gateway-bundle.mjs')).toBe(
      bundleFromPatchedSource,
    );
    const compiledBundle = buildSync({
      stdin: {
        contents: `${patched}\nexport { createManagedOutgoingMediaBlocks, sendStatus, buildManagedMediaContentDisposition, handleManagedOutgoingMediaHttpRequest };`,
        sourcefile: 'managed-media.js',
      },
      bundle: true,
      format: 'esm',
      minifySyntax: true,
      platform: 'node',
      write: false,
    }).outputFiles[0].text;
    const normalizedCompiledBundle = testing.transform(compiledBundle, 'gateway-bundle.mjs');
    expect(normalizedCompiledBundle).not.toContain(testing.MARKER);
    expect(testing.transform(normalizedCompiledBundle, 'gateway-bundle.mjs')).toBe(
      normalizedCompiledBundle,
    );
    expect(() =>
      testing.transform(patched.replace(`/*${testing.MARKER}*/`, ''), 'managed-media.js'),
    ).toThrow('historical or partial');
  });

  test('applies and verifies trusted local file media against a portable runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-local-media-patch-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const workerRoot = path.join(distRoot, 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const source = `${buildTrustedLocalFileMediaFixture()}\n${buildMediaProjectionFixture()}`;
    const files = [
      path.join(distRoot, 'managed-media.js'),
      path.join(workerRoot, 'worker.mjs'),
      path.join(fixtureRoot, 'gateway-bundle.mjs'),
    ];

    try {
      for (const filePath of files) fs.writeFileSync(filePath, source);
      const patch = patches.get('015')!;
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(3);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      fs.writeFileSync(
        files[0],
        fs
          .readFileSync(files[0], 'utf8')
          .replace(/\/\*JUSTDO_TRUSTED_LOCAL_FILE_MEDIA_V2026_9_2\*\//u, ''),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('retains original assistant MEDIA paths in the display projection', () => {
    const testing = patches.get('015')?.__testing as {
      PROJECTION_MARKER: string;
      transformDisplayProjection: (content: string, filePath: string) => string;
    };
    const patched = testing.transformDisplayProjection(
      buildMediaProjectionFixture(),
      'chat-display-projection.js',
    );
    expect(patched).toContain(`/*${testing.PROJECTION_MARKER}*/`);
    expect(patched).not.toContain('delete projectedDelivery.mediaUrls');

    const behavior = new Function(`${patched}; return takeAssistantManagedMediaUrlsForDisplay;`)() as (
      entry: Record<string, unknown>,
      role: string,
    ) => { changed: boolean; urls: string[] };
    const entry = {
      openclawDelivery: {
        mediaUrls: ['C:\\project\\result.txt', 'output\\report.pdf'],
      },
    };
    expect(behavior(entry, 'assistant')).toEqual({
      changed: false,
      urls: ['C:\\project\\result.txt', 'output\\report.pdf'],
    });
    expect(entry.openclawDelivery.mediaUrls).toEqual([
      'C:\\project\\result.txt',
      'output\\report.pdf',
    ]);
    expect(testing.transformDisplayProjection(patched, 'chat-display-projection.js')).toBe(patched);
  });

  test.skipIf(!runtimeIsV2026_9_2 || !runtimePatchSetIsCurrent)(
    'matches trusted local file media in the shared, worker, and Gateway bundle shapes',
    () => {
      const testing = patches.get('015')?.__testing as {
        transform: (content: string, filePath: string) => string;
        transformDisplayProjection: (content: string, filePath: string) => string;
      };
      const files = [
        ...findPatchedDistFiles(
          'managed-image-attachments-',
          'JUSTDO_TRUSTED_LOCAL_FILE_MEDIA_V2026_9_2',
        ),
        path.join(runtimeRoot, 'dist', 'worker', 'worker.mjs'),
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ];
      expect(files.length).toBeGreaterThanOrEqual(3);
      for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const transformed = testing.transform(content, filePath);
        expect(transformed).toContain('"application/octet-stream"');
        expect(transformed).toContain('assertLocalMediaAllowed');
        expect(transformed).toContain('maxBytesForManagedMediaKind');
        expect(testing.transform(transformed, filePath)).toBe(transformed);
      }
      const projectionFiles = [
        ...findPatchedDistFiles(
          'chat-display-projection.helpers-',
          'JUSTDO_RETAIN_ASSISTANT_MEDIA_URLS_V2026_9_2',
        ),
        path.join(runtimeRoot, 'dist', 'worker', 'worker.mjs'),
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ];
      expect(projectionFiles).toHaveLength(3);
      for (const filePath of projectionFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        expect(testing.transformDisplayProjection(content, filePath)).toBe(content);
      }
    },
    120_000,
  );

  test('admits only Goal resume through an intentionally aborted idle session', () => {
    const testing = patches.get('013')?.__testing as {
      ERROR_TEXT: string;
      transform: (content: string, filePath: string) => string;
    };
    const source = [
      'function isRestartSafeChatSession(params) {',
      '  const entry = params.entry;',
      '  return Boolean(entry?.sessionId && entry.abortedLastRun !== true && entry.archivedAt === void 0);',
      '}',
      'function resolveRestartSafeChatAdmission(params) {',
      '  return isRestartSafeChatSession(params) ? params : undefined;',
      '}',
      'async function admitChatSend(params) {',
      '  const { request, session } = params;',
      '  void session;',
      '  if (request.goalOperation && (isBusy())) throw new Error("goal-session-busy");',
      '  const restartSafeAdmission = resolveRestartSafeChatAdmission({ request: {} });',
      `  if (request.goalOperation && !restartSafeAdmission) throw new Error("${testing.ERROR_TEXT}");`,
      '}',
    ].join('\n');
    const patched = testing.transform(source, 'chat-send-handler.js');
    expect(patched).toContain(
      '(entry.abortedLastRun !== true || params.allowAbortedLastRun === true)',
    );
    expect(patched).toContain(
      'allowAbortedLastRun: request.goalOperation?.action === "resume"',
    );
    expect(testing.transform(patched, 'chat-send-handler.js')).toBe(patched);
    expect(() =>
      testing.transform(
        patched.replace(
          'request.goalOperation?.action === "resume"',
          'request.goalOperation?.action === "start"',
        ),
        'damaged-chat-send-handler.js',
      ),
    ).toThrow('historical or partial');
    expect(() =>
      testing.transform(
        patched.replace(/\/\*JUSTDO_GOAL_RESUME_ABORTED_ADMISSION_V2026_9_2\*\//u, ''),
        'partially-patched-chat-send-handler.js',
      ),
    ).toThrow('partial Goal resume admission patch');
    expect(() =>
      testing.transform(
        patched.replace(/\/\*JUSTDO_GOAL_RESUME_ABORTED_(?:ADMISSION|GUARD)_V2026_9_2\*\//gu, ''),
        'markerless-patched-chat-send-handler.js',
      ),
    ).toThrow('historical or partial');
  });

  test.skipIf(!runtimeIsV2026_9_2)(
    'matches Goal resume admission in the source, worker, and Gateway bundle shapes',
    () => {
      const testing = patches.get('013')?.__testing as {
        transform: (content: string, filePath: string) => string;
      };
      const files = [
        ...findPatchedDistFiles(
          'chat-send-handler-',
          'JUSTDO_GOAL_RESUME_ABORTED_ADMISSION_V2026_9_2',
        ),
        path.join(runtimeRoot, 'dist', 'worker', 'worker.mjs'),
        path.join(runtimeRoot, 'gateway-bundle.mjs'),
      ];
      expect(files).toHaveLength(3);
      for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        const transformed = testing.transform(content, filePath);
        expect(transformed).toContain('allowAbortedLastRun');
        expect(testing.transform(transformed, filePath)).toBe(transformed);
      }
    },
    120_000,
  );

  test('applies and verifies Goal resume admission against a portable runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-goal-resume-patch-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const workerRoot = path.join(distRoot, 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const testing = patches.get('013')?.__testing as { ERROR_TEXT: string };
    const source = [
      'function isRestartSafeChatSession(params) {',
      '  const entry = params.entry;',
      '  return Boolean(entry?.sessionId && entry.abortedLastRun !== true && entry.archivedAt === void 0);',
      '}',
      'function resolveRestartSafeChatAdmission(params) {',
      '  return isRestartSafeChatSession(params) ? params : undefined;',
      '}',
      'async function admitChatSend(params) {',
      '  const { request, session } = params;',
      '  void session;',
      '  if (request.goalOperation && isBusy()) throw new Error("goal-session-busy");',
      '  const restartSafeAdmission = resolveRestartSafeChatAdmission({ request: {} });',
      `  if (request.goalOperation && !restartSafeAdmission) throw new Error("${testing.ERROR_TEXT}");`,
      '}',
    ].join('\n');
    const files = [
      path.join(distRoot, 'runtime.js'),
      path.join(workerRoot, 'worker.mjs'),
      path.join(fixtureRoot, 'gateway-bundle.mjs'),
    ];

    try {
      for (const filePath of files) fs.writeFileSync(filePath, source);
      const patch = patches.get('013')!;
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(3);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      fs.writeFileSync(
        files[0],
        fs
          .readFileSync(files[0], 'utf8')
          .replace(/\/\*JUSTDO_GOAL_RESUME_ABORTED_ADMISSION_V2026_9_2\*\//u, ''),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('accepts only exact app-proven managed Python values', () => {
    const testing = patches.get('001')?.__testing as {
      resolveJustDoManagedPipConfigFile: (env: Record<string, string>) => string | undefined;
      resolveJustDoManagedPythonUserBase: (
        env: Record<string, string>,
      ) => string | undefined;
    };
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBe('C:\\managed\\pip.ini');
    expect(
      testing.resolveJustDoManagedPipConfigFile({
        PIP_CONFIG_FILE: 'C:\\attacker\\pip.ini',
        JUSTDO_MANAGED_PIP_CONFIG_FILE: 'C:\\managed\\pip.ini',
      }),
    ).toBeUndefined();
    expect(
      testing.resolveJustDoManagedPythonUserBase({
        PYTHONUSERBASE: 'C:\\managed\\python',
        JUSTDO_MANAGED_PYTHON_USER_BASE: 'C:\\managed\\python',
      }),
    ).toBe('C:\\managed\\python');
  });

  test('rewrites only Windows npm and npx Chrome launchers', () => {
    const testing = patches.get('003')?.__testing as {
      resolveJustDoChromeMcpLaunch: (
        command: string,
        args: string[],
        platform: string,
        environment: Record<string, string>,
      ) => { command: string; args: string[]; env?: Record<string, string> };
    };
    const environment = {
      JUSTDO_NPM_BIN_DIR: 'C:\\runtime\\npm',
      JUSTDO_ELECTRON_PATH: 'C:\\app\\electron.exe',
      JUSTDO_WINDOWS_HIDE_PRELOAD: 'C:\\app\\hide-child-process-windows.cjs',
    };
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx.cmd', ['chrome-devtools-mcp'], 'win32', environment),
    ).toMatchObject({
      command: 'C:\\app\\electron.exe',
      args: ['C:\\runtime\\npm\\npx-cli.js', 'chrome-devtools-mcp'],
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    });
    expect(
      testing.resolveJustDoChromeMcpLaunch('npx', ['chrome-devtools-mcp'], 'linux', environment),
    ).toEqual({ command: 'npx', args: ['chrome-devtools-mcp'], env: undefined });
  });

  test('patches and verifies both Chrome MCP shared and worker runtime shapes', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-chrome-mcp-patch-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const workerRoot = path.join(distRoot, 'worker');
    fs.mkdirSync(workerRoot, { recursive: true });
    const shared = [
      'async function createRealSession(options) {',
      '  const transport = new StdioClientTransport({ command: options.command, args: options.args, stderr: "pipe" });',
      '  const getStderr = drainStderr(transport);',
      '  await client.connect(transport);',
      '  throw new Error("Chrome MCP attach failed for profile");',
      '}',
    ].join('\n');
    const worker =
      'async function createRealSession(A){let B=new StdioClientTransport({command:A.command,args:A.args,stderr:`pipe`}),C=drainStderr(B);await D.connect(B);throw Error(`Chrome MCP attach failed for profile`)}';
    const sharedPath = path.join(distRoot, 'chrome-mcp.js');
    const workerPath = path.join(workerRoot, 'worker.mjs');

    try {
      fs.writeFileSync(sharedPath, shared);
      fs.writeFileSync(workerPath, worker);
      const patch = patches.get('003')!;
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(2);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      fs.writeFileSync(
        workerPath,
        fs
          .readFileSync(workerPath, 'utf8')
          .replace('JUSTDO_WINDOWS_CHROME_MCP_LAUNCH_V2026_9_2', 'damaged-marker'),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow(
        'missing Chrome MCP Windows launch contract',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(!runtimeIsV2026_9_2 || !runtimePatchSetIsCurrent)(
    'matches Chrome MCP Windows launch in the shared and worker runtime shapes',
    () => {
      const files = [
        ...findPatchedDistFiles(
          'chrome-mcp-',
          'JUSTDO_WINDOWS_CHROME_MCP_LAUNCH_V2026_9_2',
        ),
        path.join(runtimeRoot, 'dist', 'worker', 'worker.mjs'),
      ];
      expect(files).toHaveLength(2);
      for (const filePath of files) {
        expect(fs.readFileSync(filePath, 'utf8')).toContain(
          'JUSTDO_WINDOWS_CHROME_MCP_LAUNCH_V2026_9_2',
        );
      }
      expect(() => patches.get('003')?.verifyPatch(runtimeRoot)).not.toThrow();
    },
    60_000,
  );

  test('keeps Gateway restarts but retires work from a prior JustDo app start', () => {
    const testing = patches.get('008')?.__testing as {
      readJustDoAppStartedAtMs: (value: unknown) => number | undefined;
      isPriorAppActiveTask: (
        task: { status?: string; createdAt?: unknown },
        startedAt: number | undefined,
      ) => boolean;
      isPriorAppMainSession: (
        entry: { startedAt?: unknown },
        startedAt: number | undefined,
      ) => boolean;
    };
    expect(testing.readJustDoAppStartedAtMs('200')).toBe(200);
    expect(testing.readJustDoAppStartedAtMs('invalid')).toBeUndefined();
    expect(testing.isPriorAppActiveTask({ status: 'running', createdAt: 100 }, 200)).toBe(true);
    expect(testing.isPriorAppActiveTask({ status: 'queued', createdAt: 200 }, 200)).toBe(false);
    expect(testing.isPriorAppActiveTask({ status: 'completed', createdAt: 100 }, 200)).toBe(
      false,
    );
    expect(testing.isPriorAppMainSession({ startedAt: 100 }, 200)).toBe(true);
    expect(testing.isPriorAppMainSession({ startedAt: 200 }, 200)).toBe(false);
    expect(testing.isPriorAppMainSession({}, 200)).toBe(true);
    expect(testing.isPriorAppMainSession({ startedAt: 100 }, undefined)).toBe(false);
  });

  test('interrupts prior-app main sessions before native restart recovery dispatch', async () => {
    const testing = patches.get('008')?.__testing as {
      MAIN_CONTRACT: string;
      transformMain: (content: string, filePath: string) => string;
    };
    const source = [
      '// buildMainSessionRecoveryClearPatch',
      '// resolveRestartRecoveryTerminalClientRunId',
      'async function recoverStore(params) {',
      '  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };',
      '  for (const { sessionKey, entry: loadedEntry } of entries) {',
      '    let entry = loadedEntry;',
      '    const resumeDedupeKey = sessionKey;',
      '    const observed = await commitMainSessionRecovery({});',
      '    entry = observed.entry;',
      '    const recoveryView = observed.transition.view;',
      '    if (recoveryView.status === "exhausted") { continue; }',
      '  }',
      '}',
    ].join('\n');
    const transformed = testing.transformMain(source, 'main-session-restart-recovery.js');
    expect(transformed).toContain(testing.MAIN_CONTRACT);
    expect(transformed).toContain('status: "failed"');
    expect(transformed).toContain('interrupted by JustDo app restart');
    expect(transformed.indexOf('if (isJustDoPriorAppMainSession(entry))')).toBeLessThan(
      transformed.indexOf('const observed = await commitMainSessionRecovery'),
    );
    expect(testing.transformMain(transformed, 'main-session-restart-recovery.js')).toBe(
      transformed,
    );
    const compiled = buildSync({
      stdin: { contents: transformed, loader: 'js' },
      write: false,
    }).outputFiles[0]?.text;
    expect(compiled).toContain(testing.MAIN_CONTRACT);

    const executable = `${transformed}\n` +
      'globalThis.__settle = settleJustDoPriorAppMainSession;';
    const context = vm.createContext({
      process: { env: { JUSTDO_APP_STARTED_AT_MS: '200' } },
      buildMainSessionRecoveryClearPatch: () => ({
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      }),
      buildRestartRecoveryClaimCleanupPatch: () => ({
        restartRecoveryDeliveryRunId: undefined,
      }),
      resolveRestartRecoveryTerminalClientRunId: () => 'run-1',
    }) as vm.Context & {
      __entry?: Record<string, unknown>;
      __settle?: (params: Record<string, unknown>) => Promise<boolean>;
    };
    context.__entry = {
      sessionId: 'session-1',
      status: 'running',
      abortedLastRun: true,
      startedAt: 100,
      activeWriterRunId: 'writer-1',
      lifecycleRunId: 'run-1',
      restartRecoveryRuns: [{ runId: 'run-1' }],
      mainRestartRecovery: { cycleId: 'cycle-1' },
    };
    Object.assign(context, {
      applySessionEntryReplacements: async ({ update }: { update: (entries: unknown[]) => unknown }) =>
        update([{ sessionKey: 'agent:main:justdo:session-1', entry: context.__entry }]),
    });
    vm.runInContext(executable, context);

    await expect(
      context.__settle?.({
        sessionId: 'session-1',
        sessionKey: 'agent:main:justdo:session-1',
        storePath: 'sessions.sqlite',
      }),
    ).resolves.toBe(true);
    expect(context.__entry).toMatchObject({
      status: 'failed',
      abortedLastRun: false,
      activeWriterRunId: undefined,
      lifecycleRunId: undefined,
      lastRunId: 'run-1',
      lastRunError: 'interrupted by JustDo app restart',
    });
  });
  test('native forced reindex transform is idempotent and rejects ambiguity', () => {
    const testing = patches.get('009')?.__testing as {
      CACHE_SEED: string;
      FUNCTION_SIGNATURE: string;
      transformMemoryManager: (content: string, filePath: string) => string;
    };
    const source = `class MemoryManager {\n  ${testing.FUNCTION_SIGNATURE}\n    ${testing.CACHE_SEED}\n  }\n}`;
    const transformed = testing.transformMemoryManager(source, 'memory.js');
    expect(transformed).toContain(
      'params?.force === true && params?.reason === "cli"',
    );
    expect(testing.transformMemoryManager(transformed, 'memory.js')).toBe(transformed);
    expect(() =>
      testing.transformMemoryManager(`${source}\n${source}`, 'ambiguous-memory.js'),
    ).toThrow('ambiguous');
  });

  test('classifies ACP allowlist changes for native hot reload', () => {
    const testing = patches.get('024')?.__testing as {
      INSERTED: string;
      MARKER: string;
      transformReloadPlan: (content: string, filePath: string) => string;
    };
    const source = [
      'const policies = [{',
      '  prefixes: [',
      '    "diagnostics.cacheTrace.enabled",',
      '    "acp.runtime.installCommand",',
      '    "attachments.ttlHours",',
      '  ],',
      '  kind: "hot",',
      '}];',
    ].join('\n');

    const transformed = testing.transformReloadPlan(source, 'config-reload-plan.js');

    expect(transformed).toContain(testing.INSERTED);
    expect(transformed).toContain(testing.MARKER);
    expect(testing.transformReloadPlan(transformed, 'config-reload-plan.js')).toBe(transformed);
    const bundled = transformed.replace(
      testing.INSERTED,
      `"acp.allowedAgents",\n    /*${testing.MARKER}*/`,
    );
    expect(testing.transformReloadPlan(bundled, 'gateway-bundle.mjs')).toBe(bundled);
    const misplaced = transformed.replace(`    ${testing.INSERTED}\n`, '') +
      `\n${testing.INSERTED}`;
    expect(() => testing.transformReloadPlan(misplaced, 'misplaced-reload-plan.js')).toThrow(
      'partial',
    );
    expect(() =>
      testing.transformReloadPlan(`${source}\n${source}`, 'ambiguous-reload-plan.js'),
    ).toThrow('ambiguous');
  });

  test.skipIf(!runtimeIsV2026_9_2 || !runtimePatchSetIsCurrent)(
    'verifies source, worker, and esbuild bundle contracts idempotently',
    () => {
      for (const patch of patches.values()) {
        expect(() => patch.verifyPatch(runtimeRoot)).not.toThrow();
      }
    },
    300_000,
  );
});
