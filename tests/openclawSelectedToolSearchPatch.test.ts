import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, DEFERRED_TOOL_NAMES } =
  require('../scripts/patches/v2026.6.11/010-defer-selected-tool-schemas.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    DEFERRED_TOOL_NAMES: string[];
  };

const BUNDLE_FIXTURE = `function applyToolSchemaDirectoryCatalog(params) {
  return applyToolCatalogCompaction({
    ...params,
    enabled: true,
    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)
  });
}`;

test('catalogs selected heavyweight tools while leaving other tool schemas direct', () => {
  expect(DEFERRED_TOOL_NAMES).toEqual([
    'browser',
    'create_goal',
    'cron',
    'get_goal',
    'memory_get',
    'memory_search',
    'update_goal',
  ]);
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-selected-tool-search-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain(
      'shouldCatalogTool: (tool) => ["browser","create_goal","cron","get_goal","memory_get","memory_search","update_goal"].includes(tool.name)',
    );
    expect(patched).toContain('isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name)');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails when the upstream selective catalog patch point changes', () => {
  const runtimeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'justdo-selected-tool-search-mismatch-'),
  );
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, 'function applyToolSchemaDirectoryCatalog() {}', 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow(/patch target not found/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('updates a bundle patched with the previous deferred tool list', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-selected-tool-search-upgrade-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      BUNDLE_FIXTURE.replace(
        'isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name)',
        'shouldCatalogTool: (tool) => ["browser","create_goal","cron","get_goal","update_goal"].includes(tool.name),\n    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name)',
      ),
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(fs.readFileSync(bundlePath, 'utf8')).toContain(
      '["browser","create_goal","cron","get_goal","memory_get","memory_search","update_goal"].includes(tool.name)',
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
