import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import { describe, expect, test, vi } from 'vitest';

const { buildOpenClawPatchSetFingerprint } = require('../../../../scripts/verify-openclaw-runtime-patches.cjs') as {
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

  test('contains exactly the eighteen retained capability patches', () => {
    expect(patchFiles).toEqual([
      '001-managed-pip-config-environment.cjs',
      '002-windows-mcp-package-runner.cjs',
      '003-windows-chrome-mcp-launch.cjs',
      '005-final-system-prompt-replacements.cjs',
      '006-agent-request-metadata.cjs',
      '007-request-purpose-metadata.cjs',
      '008-app-startup-task-recovery-boundary.cjs',
      '009-memory-force-reembed-opt-in.cjs',
      '010-configurable-exec-approval-timeout.cjs',
      '011-plugin-approval-detail-forwarding.cjs',
      '012-configurable-plugin-approval-timeout.cjs',
      '013-goal-resume-after-pause.cjs',
      '014-assistant-display-block-replay.cjs',
      '015-trusted-local-file-media.cjs',
      '016-offline-official-plugin-catalog.cjs',
      '017-segmented-live-progress-snapshot.cjs',
      '018-mixed-tool-commentary-order.cjs',
      '019-disable-configured-plugin-auto-install.cjs',
    ]);
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
        patchSchema: (content: string, filePath: string) => string;
      };
      const schema = metadataPatch.patchSchema(
        'systemInputProvenance: T.Optional(InputProvenanceSchema), systemProvenanceReceipt: receipt',
        'chat-schema.js',
      );
      expect(schema).toContain(metadata.CONTRACT);
      expect(() =>
        metadataPatch.patchSchema(
          schema.replace(metadata.CONTRACT, metadata.CONTRACT.replace('9_2', '8_2')),
          'historical-chat-schema.js',
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
  );

  test('keeps Gateway restarts but retires tasks from a prior JustDo app start', () => {
    const testing = patches.get('008')?.__testing as {
      readJustDoAppStartedAtMs: (value: unknown) => number | undefined;
      isPriorAppActiveTask: (
        task: { status?: string; createdAt?: unknown },
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

  test('configurable exec approval timeout supports finite and true no-expiry waits', () => {
    const testing = patches.get('010')?.__testing as {
      ENV_NAME: string;
      INDEFINITE_EXPIRES_AT_MS: number;
      MARKERS: Record<string, string>;
      resolveJustDoExecApprovalTimeoutMs: (value: unknown, fallback: number) => number;
      transformDefaults: (content: string, filePath: string) => string;
      transformGateway: (content: string, filePath: string) => string;
      transformManager: (content: string, filePath: string) => string;
      transformWait: (content: string, filePath: string) => string;
    };
    expect(testing.resolveJustDoExecApprovalTimeoutMs('600000', 123)).toBe(600_000);
    expect(testing.resolveJustDoExecApprovalTimeoutMs('0', 123)).toBe(
      testing.INDEFINITE_EXPIRES_AT_MS,
    );

    const defaults = [
      'DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
    ].join('\n');
    const patchedDefaults = testing.transformDefaults(defaults, 'exec-runtime.js');
    expect(patchedDefaults).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedDefaults).toContain('Number.MAX_SAFE_INTEGER?3e4');
    expect(testing.transformDefaults(patchedDefaults, 'exec-runtime.js')).toBe(patchedDefaults);

    const wait =
      'callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id })';
    const patchedWait = testing.transformWait(wait, 'exec-request.js');
    expect(patchedWait).toContain('Number.MAX_SAFE_INTEGER?null');
    expect(testing.transformWait(patchedWait, 'exec-request.js')).toBe(patchedWait);

    const gateway =
      'const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;';
    const patchedGateway = testing.transformGateway(gateway, 'gateway.js');
    expect(patchedGateway).toContain('opts?.timeoutMs===null?null');
    expect(testing.transformGateway(patchedGateway, 'gateway.js')).toBe(patchedGateway);

    const manager = [
      'const now = Date.now();',
      'const resolvedTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });',
    ].join('\n');
    const patchedManager = testing.transformManager(manager, 'approval-manager.js');
    expect(patchedManager).toContain('timeoutMs===Number.MAX_SAFE_INTEGER');
    expect(testing.transformManager(patchedManager, 'approval-manager.js')).toBe(patchedManager);
    const directTimerManager =
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveTimerTimeoutMs(timeoutMs, 1), { nowMs: now });';
    const patchedDirectTimer = testing.transformManager(
      directTimerManager,
      'approval-manager-worker.js',
    );
    expect(patchedDirectTimer).toContain('resolveTimerTimeoutMs(timeoutMs, 1)');
    expect(patchedDirectTimer).not.toContain('resolveApprovalTimeoutMs(timeoutMs)');
    expect(testing.transformManager(patchedDirectTimer, 'approval-manager-worker.js')).toBe(
      patchedDirectTimer,
    );
    expect(() =>
      testing.transformDefaults(
        patchedDefaults.replace('Number.MAX_SAFE_INTEGER', 'Number.MAX_VALUE'),
        'damaged-exec-runtime.js',
      ),
    ).toThrow('historical or partial');
  });

  test('forwards reviewer-only plugin approval detail on both dispatch paths', () => {
    const testing = patches.get('011')?.__testing as {
      MARKER: string;
      transformApprovalDispatch: (content: string, filePath: string) => string;
    };
    const dispatch = [
      'allowedDecisions: approval.allowedDecisions, toolName: params.toolName,',
      'allowedDecisions: approval.allowedDecisions, toolName: params.toolName,',
    ].join('\n');
    const patched = testing.transformApprovalDispatch(dispatch, 'approval-dispatch.js');
    expect(patched.match(new RegExp(testing.MARKER, 'gu'))).toHaveLength(2);
    expect(patched).toContain('...(approval.detail ? { detail: approval.detail } : {})');
    expect(testing.transformApprovalDispatch(patched, 'approval-dispatch.js')).toBe(patched);
    expect(() => testing.transformApprovalDispatch(dispatch.split('\n')[0], 'partial.js')).toThrow(
      'expected 2',
    );
    expect(() =>
      testing.transformApprovalDispatch(
        patched.replace('...(approval.detail ? { detail: approval.detail } : {})', '{}'),
        'damaged-detail.js',
      ),
    ).toThrow('historical or partial');
  });

  test('configurable plugin approval timeout supports long and no-expiry waits', () => {
    const testing = patches.get('012')?.__testing as {
      ENV_NAME: string;
      MARKERS: Record<string, string>;
      transformBounds: (content: string, filePath: string) => string;
      transformCliNativeToolApproval: (content: string, filePath: string) => string;
      transformNativeHookRelayApproval: (content: string, filePath: string) => string;
      transformTransport: (content: string, filePath: string) => string;
    };
    const bounds = [
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;',
    ].join('\n');
    const patchedBounds = testing.transformBounds(bounds, 'plugin-approvals.js');
    expect(patchedBounds).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedBounds).toContain('Number.MAX_SAFE_INTEGER');
    expect(patchedBounds).not.toContain('DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4');
    expect(testing.transformBounds(patchedBounds, 'plugin-approvals.js')).toBe(patchedBounds);

    const transport = [
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, {',
      '  title: approval.title, description: approval.description, ...approval.scope',
    ].join('\n');
    const patchedTransport = testing.transformTransport(transport, 'approval-dispatch.js');
    expect(patchedTransport).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(patchedTransport).toContain('gatewayTimeoutMs===null?3e4:gatewayTimeoutMs');
    expect(testing.transformTransport(patchedTransport, 'approval-dispatch.js')).toBe(
      patchedTransport,
    );

    const cliApproval = [
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const timeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const gatewayTimeoutMs = addTimerTimeoutGraceMs(timeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? timeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const requestResult = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
    ].join('\n');
    const patchedCli = testing.transformCliNativeToolApproval(cliApproval, 'cli-approval.js');
    expect(patchedCli).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedCli).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(patchedCli).toContain('gatewayTimeoutMs===null?3e4:gatewayTimeoutMs');
    expect(testing.transformCliNativeToolApproval(patchedCli, 'cli-approval.js')).toBe(patchedCli);

    const relayApproval = [
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const timeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  const result = await callGatewayTool("plugin.approval.request", { timeoutMs: timeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');
    const patchedRelay = testing.transformNativeHookRelayApproval(
      relayApproval,
      'native-hook-relay.js',
    );
    expect(patchedRelay).toContain(`process.env.${testing.ENV_NAME}`);
    expect(patchedRelay).toContain('timeoutMs===Number.MAX_SAFE_INTEGER?3e4');
    expect(patchedRelay).toContain('params.timeoutMs===Number.MAX_SAFE_INTEGER?null');
    expect(testing.transformNativeHookRelayApproval(patchedRelay, 'native-hook-relay.js')).toBe(
      patchedRelay,
    );
    expect(() =>
      testing.transformCliNativeToolApproval(
        patchedCli.replace(`process.env.${testing.ENV_NAME}`, 'process.env.WRONG_TIMEOUT'),
        'damaged-cli-approval.js',
      ),
    ).toThrow('historical or partial');
  });

  test('applies and verifies approval patches against a portable pristine runtime fixture', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-patches-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(distRoot, { recursive: true });
    const commonSource = [
      'const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
      'async function resolveRegisteredExecApprovalDecision() {',
      '  return callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id });',
      '}',
      'const APPROVAL_RUNTIME_METHODS = [];',
      'function resolveGatewayOptions() {',
      '  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;',
      '}',
      'const approvalWarning = "approval expiry is unavailable";',
      'const now = Date.now();',
      'const resolvedTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });',
      'async function requestPluginToolApproval() {',
      '  const embedded = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '  const gateway = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '}',
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: approval.title, description: approval.description, ...approval.scope });',
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const cliTimeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const cliGatewayTimeoutMs = addTimerTimeoutGraceMs(cliTimeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? cliTimeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const result = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: cliGatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
      'const DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;',
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const relayTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  return callGatewayTool("plugin.approval.request", { timeoutMs: relayTimeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');

    try {
      const commonFiles = [path.join(distRoot, 'runtime-a.js'), path.join(distRoot, 'runtime-b.js')];
      for (const filePath of commonFiles) fs.writeFileSync(filePath, commonSource);
      fs.writeFileSync(
        path.join(distRoot, 'plugin-bounds-only.js'),
        'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS$1 = 6e5;',
      );

      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id);
        expect(patch).toBeDefined();
        expect(patch!.applyPatch(fixtureRoot).length).toBeGreaterThan(0);
        expect(() => patch!.verifyPatch(fixtureRoot)).not.toThrow();
        expect(patch!.applyPatch(fixtureRoot)).toEqual([]);
      }

      const target = commonFiles[0];
      const exactPatched = fs.readFileSync(target, 'utf8');
      fs.writeFileSync(
        target,
        exactPatched.replace('Number.MAX_SAFE_INTEGER', 'Number.MAX_VALUE'),
      );
      expect(() => patches.get('010')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
      fs.writeFileSync(target, exactPatched);

      fs.writeFileSync(
        target,
        exactPatched.replace('...(approval.detail ? { detail: approval.detail } : {})', '{}'),
      );
      expect(() => patches.get('011')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
      fs.writeFileSync(target, exactPatched);

      fs.writeFileSync(
        target,
        exactPatched.replace(
          `justDoPluginApprovalTimeout=process.env.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS`,
          'justDoPluginApprovalTimeout=process.env.WRONG_TIMEOUT',
        ),
      );
      expect(() => patches.get('012')!.verifyPatch(fixtureRoot)).toThrow(
        'historical or partial',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('verifies approval contracts after esbuild reformats the patched sources', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-bundle-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(distRoot, { recursive: true });
    const commonSource = [
      'const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;',
      'const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 1e4;',
      'async function resolveRegisteredExecApprovalDecision() {',
      '  return callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id });',
      '}',
      'const APPROVAL_RUNTIME_METHODS = [];',
      'function resolveGatewayOptions() {',
      '  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;',
      '}',
      'const approvalWarning = "approval expiry is unavailable";',
      'const now = Date.now();',
      'const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });',
      'async function requestPluginToolApproval() {',
      '  const embedded = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '  const gateway = { allowedDecisions: approval.allowedDecisions, toolName: params.toolName };',
      '}',
      'const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 12e4;',
      'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      'function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs) {',
      '  return addTimerTimeoutGraceMs(timeoutMs, 1e4) ?? 13e4;',
      '}',
      'callGatewayTool("plugin.approval.request", { timeoutMs: gatewayTimeoutMs }, { title: approval.title, description: approval.description, ...approval.scope });',
      'function waitForCliNativeToolApproval(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.gatewayTimeoutMs }, { id: params.id });',
      '}',
      'async function requestCliNativeToolApproval(params) {',
      '  const cliTimeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;',
      '  const cliGatewayTimeoutMs = addTimerTimeoutGraceMs(cliTimeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ?? cliTimeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;',
      '  const result = await raceCliNativeToolApprovalAbort(callGatewayTool("plugin.approval.request", { timeoutMs: cliGatewayTimeoutMs }, { title: "Run tool" }));',
      '}',
      'const DEFAULT_PERMISSION_TIMEOUT_MS = 12e4;',
      'async function requestNativeHookRelayPermissionApproval(request) {',
      '  const relayTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS;',
      '  return callGatewayTool("plugin.approval.request", { timeoutMs: relayTimeoutMs + 10_000 }, { pluginId: `openclaw-native-hook-relay-${request.provider}` });',
      '}',
      'async function waitForNativeHookRelayApprovalDecision(params) {',
      '  return callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 10_000 }, { id: params.approvalId });',
      '}',
    ].join('\n');

    try {
      const commonFiles = [path.join(distRoot, 'runtime-a.js'), path.join(distRoot, 'runtime-b.js')];
      for (const filePath of commonFiles) fs.writeFileSync(filePath, commonSource);
      fs.writeFileSync(
        path.join(distRoot, 'plugin-bounds-only.js'),
        'const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 6e5;',
      );

      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id);
        expect(patch).toBeDefined();
        expect(patch!.applyPatch(fixtureRoot).length).toBeGreaterThan(0);
      }

      const entryPath = path.join(fixtureRoot, 'entry.js');
      fs.writeFileSync(
        entryPath,
        [
          "import './dist/runtime-a.js';",
          "import './dist/plugin-bounds-only.js';",
        ].join('\n'),
      );
      const bundle = buildSync({
        bundle: true,
        entryPoints: [entryPath],
        format: 'esm',
        legalComments: 'none',
        platform: 'node',
        treeShaking: false,
        write: false,
      }).outputFiles[0].text;
      fs.writeFileSync(path.join(fixtureRoot, 'gateway-bundle.mjs'), bundle);

      const execTesting = patches.get('010')?.__testing as {
        MARKERS: Record<string, string>;
        transformDefaults: (content: string, filePath: string) => string;
      };
      const detailTesting = patches.get('011')?.__testing as {
        transformApprovalDispatch: (content: string, filePath: string) => string;
      };
      const pluginTimeoutTesting = patches.get('012')?.__testing as {
        transformBounds: (content: string, filePath: string) => string;
      };
      expect(bundle).not.toContain(execTesting.MARKERS.defaults);
      for (const id of ['010', '011', '012']) {
        const patch = patches.get(id)!;
        expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
        expect(patch.applyPatch(fixtureRoot)).toEqual([]);
      }

      expect(() =>
        execTesting.transformDefaults(
          bundle.replace('justDoApprovalTimeout === "0"', 'justDoApprovalTimeout === " 0 "'),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
      expect(() =>
        detailTesting.transformApprovalDispatch(
          bundle.replace(
            '...approval.detail ? { detail: approval.detail } : {}',
            '...{}',
          ),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
      expect(() =>
        pluginTimeoutTesting.transformBounds(
          bundle.replace(
            'justDoPluginApprovalTimeout = process.env.JUSTDO_EXEC_APPROVAL_TIMEOUT_MS',
            'justDoPluginApprovalTimeout = process.env.WRONG_APPROVAL_TIMEOUT_MS',
          ),
          'gateway-bundle.mjs',
        ),
      ).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test.skipIf(!runtimeIsV2026_9_2 || !runtimePatchSetIsCurrent)(
    'verifies source, worker, and esbuild bundle contracts idempotently',
    () => {
      for (const patch of patches.values()) {
        expect(() => patch.verifyPatch(runtimeRoot)).not.toThrow();
      }
    },
    120_000,
  );
});
