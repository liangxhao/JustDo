import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = path.resolve(process.argv[2] ?? path.join(root, 'vendor/openclaw-runtime/current'));
const runtimePackage = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(runtimePackage.version, '2026.9.8');
const output = await mkdtemp(path.join(os.tmpdir(), 'interactive-ui-contract-'));
try {
  await build({
    entryPoints: [path.join(root, 'openclaw-extensions/interactive-ui/index.ts')],
    outfile: path.join(output, 'plugin.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2022',
  });
  const plugin = (await import(pathToFileURL(path.join(output, 'plugin.mjs')).href)).default;
  const filename = (await readdir(path.join(runtime, 'dist'))).find(name =>
    /^board-widget-content-kinds-.*\.mjs$/.test(name),
  );
  assert.ok(filename, 'Locked runtime registrar module missing');
  const source = await readFile(path.join(runtime, 'dist', filename), 'utf8');
  const alias = source.match(/createPluginBoardWidgetContentKindRegistrar as (\w+)/)?.[1];
  assert.ok(alias, 'Locked runtime registrar export missing');
  const native = await import(pathToFileURL(path.join(runtime, 'dist', filename)).href);
  const registry = { boardWidgetContentKinds: new Map() };
  const register = native[alias](registry);
  plugin.register({
    registerBoardWidgetContentKind: definition => register({ id: plugin.id }, definition),
  });
  assert.deepEqual([...registry.boardWidgetContentKinds.keys()].sort(), [
    'interactive-answer',
    'scenario-explorer',
  ]);
  const definition = registry.boardWidgetContentKinds.get('scenario-explorer').definition;
  const uiDefinition = registry.boardWidgetContentKinds.get('interactive-answer').definition;
  assert.equal(
    registry.boardWidgetContentKinds.get('interactive-answer').pluginKind,
    'interactive-ui:interactive-answer',
  );
  // Plugin IDs and content-kind IDs are distinct. The native registrar admits
  // identical names, but still rejects a kind claimed by another registration.
  const sameNameRegistry = { boardWidgetContentKinds: new Map() };
  const registerSameName = native[alias](sameNameRegistry);
  registerSameName({ id: plugin.id }, { ...uiDefinition, kind: plugin.id });
  assert.equal(
    sameNameRegistry.boardWidgetContentKinds.get(plugin.id).pluginKind,
    `${plugin.id}:${plugin.id}`,
  );
  assert.throws(
    () =>
      registerSameName(
        { id: 'other-plugin' },
        {
          ...uiDefinition,
          kind: plugin.id,
          resources: { ...uiDefinition.resources, paths: ['/other-plugin/renderer.js'] },
        },
      ),
    /duplicate kind/,
  );
  assert.throws(
    () => register({ id: 'invalid' }, { ...definition, kind: 'scenario_explorer' }),
    /invalid or reserved/,
  );
  assert.throws(
    () =>
      register(
        { id: 'invalid' },
        { ...definition, kind: 'other', resources: { ...definition.resources, paths: [] } },
      ),
    /resource paths must be/,
  );
  assert.throws(
    () =>
      register(
        { id: plugin.id },
        { ...uiDefinition, kind: 'resource-conflict', resources: definition.resources },
      ),
    /public resource paths must be unique/,
  );
  assert.deepEqual(uiDefinition.resources.paths, ['/__interactive_ui__/ui.js']);
  for (const kind of [definition, uiDefinition]) {
    for (const resourcePath of kind.resources.paths) {
      const resource = await kind.resources.readPublicResource(resourcePath);
      assert.ok(resource?.body.byteLength);
      assert.equal(resource.contentType, 'text/javascript; charset=utf-8');
      new Script(new TextDecoder().decode(resource.body));
    }
    assert.equal(await kind.resources.readPublicResource('/unregistered'), undefined);
  }
  const scenario = {
    version: 1,
    language: 'zh',
    summary: '</script><b>Test</b>',
    tasks: [{ label: 'Synthetic', hours: 448 }],
    dailyRate: 700,
    budget: 80000,
    deadline: 21,
    people: 6,
    focus: 6,
  };
  const html = definition.composeDocument({
    source: JSON.stringify(scenario),
    title: 'Synthetic',
    resourceUrls: { [definition.resources.paths[0]]: definition.resources.paths[0] },
    promptGranted: false,
  });
  assert.ok(!html.includes(scenario.summary));
  assert.ok(html.includes(definition.resources.paths[0]));
  const ui = {
    version: 1,
    language: 'en',
    summary: '</script><b>Controlled UI</b>',
    blocks: [
      {
        type: 'table',
        id: 'table',
        title: 'Delivery data',
        columns: [
          { id: 'name', label: 'Name', type: 'text' },
          { id: 'days', label: 'Days', type: 'number' },
        ],
        rows: [
          ['Lean', 39],
          ['Balanced', 18],
        ],
      },
      {
        type: 'compare',
        id: 'compare',
        title: 'Plans',
        metrics: ['Days', 'Cost'],
        items: [
          { id: 'lean', title: 'Lean', values: [39, 81900] },
          { id: 'balanced', title: 'Balanced', values: [18, 75600] },
        ],
      },
      {
        type: 'chart',
        id: 'chart',
        title: 'Delivery',
        chartType: 'line',
        labels: ['Day 1', 'Day 2'],
        unit: 'hours',
        series: [{ id: 'balanced', label: 'Balanced', values: [25.8, 51.6] }],
      },
      {
        type: 'form',
        id: 'form',
        title: 'Requirements',
        fields: [
          { id: 'topic', label: 'Topic', type: 'text', value: 'Synthetic', required: true },
          { id: 'budget', label: 'Budget', type: 'number', value: 80000, min: 0, max: 1000000 },
          {
            id: 'plan',
            label: 'Plan',
            type: 'select',
            value: 'Balanced',
            options: ['Lean', 'Balanced'],
          },
          { id: 'confirmed', label: 'Confirmed', type: 'checkbox', value: true },
        ],
      },
      {
        type: 'steps',
        id: 'steps',
        title: 'Explanation',
        items: [
          { title: 'Choose inputs', body: 'Use explicit assumptions.' },
          { title: 'Compare', body: 'Check the common source data.' },
        ],
      },
    ],
  };
  const uiSource = JSON.stringify(ui);
  uiDefinition.validateSource(uiSource);
  assert.throws(() => uiDefinition.validateSource(JSON.stringify({ ...ui, unexpected: true })));
  const uiHtml = uiDefinition.composeDocument({
    source: uiSource,
    title: 'Controlled UI',
    resourceUrls: Object.fromEntries(
      uiDefinition.resources.paths.map(resourcePath => [resourcePath, resourcePath]),
    ),
    promptGranted: false,
  });
  assert.ok(!uiHtml.includes(ui.summary));
  assert.ok(uiHtml.includes(uiDefinition.resources.paths[0]));
  console.log(
    JSON.stringify({
      runtime: runtimePackage.version,
      kinds: [definition.kind, uiDefinition.kind],
      registered: true,
      samePluginAndKindNameAccepted: true,
      duplicateKindRejected: true,
      invalidKindRejected: true,
      emptyResourceRejected: true,
      duplicateResourceRejected: true,
      unknownFieldRejected: true,
      rendererSyntaxValid: true,
      escaped: true,
    }),
  );
} finally {
  assert.equal(path.dirname(output), path.resolve(os.tmpdir()));
  assert.ok(path.basename(output).startsWith('interactive-ui-contract-'));
  await rm(output, { recursive: true, force: true });
}
