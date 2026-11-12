import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const requestedRuntime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
const runtime = path.resolve(requestedRuntime ?? 'vendor/openclaw-runtime/current');
const executable = path.join(
  runtime,
  'node-runtime',
  process.platform === 'win32' ? 'node.exe' : 'bin/node',
);
const runtimeAvailable =
  fs.existsSync(path.join(runtime, 'openclaw.mjs')) && fs.existsSync(executable);
const targetVersion = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
  .openclaw.version.replace(/^v/u, '');

if (requestedRuntime && !runtimeAvailable) {
  throw new Error(`The explicitly selected native runtime is unavailable: ${runtime}`);
}

test.skipIf(!runtimeAvailable)(
  'native session skill snapshots select the current project before a same-named plugin skill',
  () => {
    const temporaryParent = fs.realpathSync(os.tmpdir());
    const fixture = fs.mkdtempSync(path.join(temporaryParent, 'skill-precedence-fixture-'));
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          !/^(OPENCLAW_|VITEST(?:_|$)|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name),
        ),
      );
      const output = execFileSync(
        executable,
        [
          path.resolve('tests/openclaw/runtime/project-skill-precedence.native-probe.mjs'),
          runtime,
          fixture,
          targetVersion,
        ],
        { env, encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(output.split(/\r?\n/u)).toContain('PROJECT_SKILL_PRECEDENCE_OK');
    } finally {
      const resolvedFixture = fs.realpathSync(fixture);
      expect(path.dirname(resolvedFixture)).toBe(temporaryParent);
      expect(path.basename(resolvedFixture)).toMatch(/^skill-precedence-fixture-/u);
      fs.rmSync(resolvedFixture, { recursive: true, force: true });
    }
  },
  40_000,
);
