import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { SCHEDULED_TASK_READ_ONLY_TOOLS } from '../../../src/shared/scheduledTask/permissions';

const dist = path.resolve(
  process.env.JUSTDO_TEST_PRISTINE_RUNTIME ?? 'vendor/openclaw-runtime/current',
  'dist',
);
const available = fs.existsSync(dist);

async function loadNativeToolPolicy() {
  const file = fs
    .readdirSync(dist)
    .find(name => /^attempt-tool-construction-plan-.*\.m?js$/u.test(name));
  if (!file) throw new Error('Native attempt tool construction policy module is missing');
  const source = fs.readFileSync(path.join(dist, file), 'utf8');
  const filterExport = source.match(/applyEmbeddedAttemptToolsAllow as (\w+)/u)?.[1];
  const mergeExport = source.match(/mergeForcedEmbeddedAttemptToolsAllow as (\w+)/u)?.[1];
  if (!filterExport || !mergeExport) throw new Error('Native tool policy exports changed');
  const native = await import(/* @vite-ignore */ pathToFileURL(path.join(dist, file)).href);
  return {
    filter: native[filterExport] as (
      tools: { name: string }[],
      allow: readonly string[],
    ) => { name: string }[],
    merge: native[mergeExport] as (
      allow: readonly string[],
      options: { forceMessageTool?: boolean },
    ) => string[],
  };
}

describe.skipIf(!available)(
  'scheduled task permissions against the installed native runtime',
  () => {
    test('read-only excludes command, mutation, delegation and arbitrary MCP tools from execution', async () => {
      const { filter } = await loadNativeToolPolicy();
      const tools = [
        ...SCHEDULED_TASK_READ_ONLY_TOOLS,
        'exec',
        'process',
        'write',
        'edit',
        'apply_patch',
        'browser',
        'sessions_spawn',
        'sessions_send',
        'automations',
        'message',
        'mcp__example__write',
      ].map(name => ({ name }));
      expect(filter(tools, SCHEDULED_TASK_READ_ONLY_TOOLS).map(tool => tool.name)).toEqual([
        ...SCHEDULED_TASK_READ_ONLY_TOOLS,
      ]);
      expect(filter(tools, [])).toEqual([]);
      expect(filter(tools, ['*'])).toEqual(tools);
    });

    test('host-required message delivery does not grant command or filesystem mutation tools', async () => {
      const { filter, merge } = await loadNativeToolPolicy();
      const allow = merge(SCHEDULED_TASK_READ_ONLY_TOOLS, { forceMessageTool: true });
      const tools = ['read', 'message', 'exec', 'write', 'sessions_spawn'].map(name => ({ name }));
      expect(filter(tools, allow).map(tool => tool.name)).toEqual(['read', 'message']);
    });
  },
);
