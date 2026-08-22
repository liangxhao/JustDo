import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/038-case-insensitive-subagent-task-names.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

type TaskNameResult = { taskName?: string; error?: string };
type FixtureRuntime = { normalizeSubagentTaskName: (value: unknown) => TaskNameResult };

const temporaryRoots: string[] = [];

const FIXTURE_SOURCE = `
function normalizeOptionalString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
const SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const RESERVED_SUBAGENT_TASK_NAMES = new Set(["all", "last"]);
function normalizeSubagentTaskName(value) {
  const taskName = normalizeOptionalString(value);
  if (!taskName) return {};
  if (!SUBAGENT_TASK_NAME_RE.test(taskName)) return { error: \`Invalid taskName "\${taskName}". Use 1-64 chars matching [a-z][a-z0-9_-]*.\` };
  if (RESERVED_SUBAGENT_TASK_NAMES.has(taskName)) return { error: \`Invalid taskName "\${taskName}". Reserved subagent targets cannot be used as taskName values.\` };
  return { taskName };
}
function createSessionsSpawnToolSchema(params) {
  return {
    taskName: Type.Optional(Type.String({ description: "Stable alias for later targeting; lowercase letters/digits/underscores/hyphens, starts letter." }))
  };
}
const nativeCommandGuidanceLines = [
  '- Set \`taskName\` when you will need a stable handle later; keep it lowercase with underscores or hyphens. Omit \`context\` for isolated children; set \`context:"fork"\` only when current transcript details matter.'
];
module.exports = { normalizeSubagentTaskName };
`;

function createRuntime(options: { bundle?: boolean } = {}): {
  root: string;
  sourcePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-task-name-case-'));
  temporaryRoots.push(root);
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const sourcePath = path.join(distDir, 'openclaw-tools.js');
  fs.writeFileSync(sourcePath, FIXTURE_SOURCE, 'utf8');
  if (options.bundle) {
    const esbuildBundle = FIXTURE_SOURCE.replace(
      'const SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;',
      'var SUBAGENT_TASK_NAME_RE;\nSUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;',
    );
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), esbuildBundle, 'utf8');
  }
  return { root, sourcePath };
}

function loadRuntime(sourcePath: string): FixtureRuntime {
  const fixtureModule = { exports: {} as FixtureRuntime };
  const loadFixture = new Function('module', 'exports', fs.readFileSync(sourcePath, 'utf8'));
  loadFixture(fixtureModule, fixtureModule.exports);
  return fixtureModule.exports;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenClaw v2026.7.1-2 mixed-case sessions_spawn taskName aliases', () => {
  test('preserves uppercase input while keeping the identifier boundary', () => {
    const { root, sourcePath } = createRuntime();
    patch.applyPatch(root);
    patch.verifyPatch(root);
    const runtime = loadRuntime(sourcePath);

    expect(runtime.normalizeSubagentTaskName('API_Report-V2')).toEqual({
      taskName: 'API_Report-V2',
    });
    expect(runtime.normalizeSubagentTaskName('a'.repeat(64))).toEqual({ taskName: 'a'.repeat(64) });
    expect(runtime.normalizeSubagentTaskName('1-report').error).toContain('[A-Za-z]');
    expect(runtime.normalizeSubagentTaskName('report.title').error).toContain('[A-Za-z]');
    expect(runtime.normalizeSubagentTaskName('任务').error).toContain('[A-Za-z]');
    expect(runtime.normalizeSubagentTaskName('a'.repeat(65)).error).toContain('[A-Za-z]');
  });

  test.each(['all', 'ALL', 'All', 'last', 'LAST', 'Last'])(
    'rejects the case-insensitive reserved target %s',
    taskName => {
      const { root, sourcePath } = createRuntime();
      patch.applyPatch(root);
      const runtime = loadRuntime(sourcePath);

      expect(runtime.normalizeSubagentTaskName(taskName).error).toContain(
        'Reserved subagent targets',
      );
    },
  );

  test('patches source and bundle together, updates guidance, and is byte-stable', () => {
    const { root, sourcePath } = createRuntime({ bundle: true });

    expect(patch.applyPatch(root)).toEqual([
      path.join('dist', 'openclaw-tools.js'),
      'gateway-bundle.mjs',
    ]);
    patch.verifyPatch(root);
    const once = fs.readFileSync(sourcePath);
    const content = once.toString('utf8');
    expect(content).toContain('/^[A-Za-z][A-Za-z0-9_-]{0,63}$/');
    expect(content).toContain('RESERVED_SUBAGENT_TASK_NAMES.has(taskName.toLowerCase())');
    expect(content).toContain('letters/digits/underscores/hyphens');

    expect(patch.applyPatch(root)).toEqual([]);
    expect(fs.readFileSync(sourcePath)).toEqual(once);
  });

  test('rejects a partial artifact without writing it', () => {
    const { root, sourcePath } = createRuntime();
    const partial = fs
      .readFileSync(sourcePath, 'utf8')
      .replace(
        'const SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;',
        'const SUBAGENT_TASK_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;',
      );
    fs.writeFileSync(sourcePath, partial, 'utf8');

    expect(() => patch.applyPatch(root)).toThrow(/partial artifact/);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(partial);
  });

  test('rejects ambiguous native and patched anchors', () => {
    const native = createRuntime();
    fs.appendFileSync(
      native.sourcePath,
      '\nconst SUBAGENT_TASK_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;\n',
    );
    expect(() => patch.applyPatch(native.root)).toThrow(/anchor count is 2/);

    const patched = createRuntime();
    patch.applyPatch(patched.root);
    fs.appendFileSync(
      patched.sourcePath,
      '\nconst SUBAGENT_TASK_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;\n',
    );
    expect(() => patch.verifyPatch(patched.root)).toThrow(/anchor is ambiguous/);
  });
});
