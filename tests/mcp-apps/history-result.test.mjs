import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const built = await build({
  entryPoints: ['plugins/extensions/runtime-services/mcp-app-history-result.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { selectMcpAppHistoryResult: select } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
);
const inputModule = await build({
  entryPoints: ['plugins/extensions/runtime-services/mcp-app-history-input.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { matchesMcpAppHistoryInput: matches } = await import(
  `data:text/javascript;base64,${Buffer.from(inputModule.outputFiles[0].text).toString('base64')}`
);
test('historical input matching accepts explicit defaults and stable object order', () => {
  const schema = {
    properties: {
      metric: { default: 'retention' },
      periodType: { default: 'monthly' },
      cohortCount: { default: 12 },
      maxPeriods: { default: 12 },
    },
  };
  assert.equal(
    matches(
      {},
      { metric: 'retention', periodType: 'monthly', cohortCount: 12, maxPeriods: 12 },
      schema,
    ),
    true,
  );
  assert.equal(matches({ filters: { a: 1, b: 2 } }, { filters: { b: 2, a: 1 } }, {}), true);
  for (const requested of [
    { metric: 'revenue' },
    { periodType: 'weekly' },
    { cohortCount: 6 },
    { extra: true },
  ])
    assert.equal(matches({}, requested, schema), false);
});
test('historical input matching rejects malformed values and excessive inputs', () => {
  for (const input of [
    null,
    [],
    { value: NaN },
    { value: undefined },
    { value: 'x'.repeat(65537) },
  ])
    assert.equal(matches(input, input, {}), false);
  const deep = { value: {} };
  let nested = deep.value;
  for (let i = 0; i < 18; i++) nested = nested.value = {};
  assert.equal(matches(deep, deep, {}), false);
});
const key = 'agent:main:history';
const viewId = 'mcp-app-original';
const activity = () => ({
  role: 'custom',
  customType: 'openclaw.nested-tool.v1',
  display: true,
  excludeFromContext: true,
  details: {
    runId: 'run',
    parentToolCallId: 'parent',
    toolCallId: 'child',
    toolName: 'budget__show',
    input: { rows: 3 },
    isError: false,
    result: {
      content: [{ type: 'text', text: 'original' }],
      details: {
        mcpServer: 'budget',
        mcpTool: 'show',
        structuredContent: { total: 100 },
        mcpAppPreview: {
          mcpApp: {
            viewId,
            serverName: 'budget',
            toolName: 'show',
            toolCallId: 'child',
            uiResourceUri: 'ui://budget/app',
            originSessionKey: key,
          },
        },
      },
    },
  },
});
test('historical App restoration selects exact native child evidence', () => {
  const original = activity();
  const result = select([original], viewId, key);
  assert.deepEqual(result.toolInput, { rows: 3 });
  assert.deepEqual(result.toolResult.structuredContent, { total: 100 });
  assert.equal(result.uiResourceUri, 'ui://budget/app');
  assert.equal(select([{ role: 'assistant', content: [original] }], viewId, key), undefined);
});
test('historical App restoration rejects failure, omitted results and mismatched ownership', () => {
  for (const change of [
    x => {
      x.details.isError = true;
    },
    x => {
      x.details.parentToolCallId = '';
    },
    x => {
      x.details.toolCallId = 'sibling';
    },
    x => {
      x.details.result.details.mcpServer = 'other';
    },
    x => {
      x.details.result.details.mcpAppPreview.mcpApp.originSessionKey = 'agent:other:session';
    },
    x => {
      x.details.result.details.mcpAppPreview.mcpApp.resultMetaState = 'unavailable';
    },
    x => {
      x.details.result.details.structuredContent = undefined;
      x.details.result.details.status = 'error';
    },
    x => {
      x.details.input = '[Nested tool input omitted: exceeds display limit]';
    },
  ]) {
    const original = activity();
    change(original);
    assert.equal(select([original], viewId, key), undefined);
  }
});
