import { AsyncLocalStorage } from 'node:async_hooks';

import { expect, test, vi } from 'vitest';

const { transform } = require('../../../../scripts/patches/v2026.10.7/038-subagent-model-inventory.cjs').__testing;

const modelImport = 'import { t as prepareModelChoice } from "./model-runtime-choice-B7hQ9HF8.mjs";';
const plan = `async function resolveSubagentModelAndThinkingPlan(params) {
  const rawResolvedModel = params.model;
  const inheritedModel = params.inheritedModel;
  const modelOverrideSource = params.modelOverrideSource;
  let choice;
  try {
    choice = await prepareModelChoice({
      cfg: params.cfg,
      agentId: params.targetAgentId,
      workspaceDir: params.workspaceDir,
      raw: rawResolvedModel,
      source: modelOverrideSource === "user" ? "override" : "automatic",
      ...inheritedModel ? { resolvedRef: inheritedModel } : {},
      ...modelOverrideSource === "auto" ? { fallbacks: modelFallbackOverrideFromAvailability(resolveModelFallbackAvailability({
        cfg: params.cfg,
        agentId: params.targetAgentId,
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
        subagentSpawnLineage: true
      })) } : {}
    });
  } catch (error) {
    return { status: "error", error: \`sessions_spawn could not verify the selected model: \${error.message}\` };
  }
  return choice;
}`;

const nativeScope = `function runOutsidePluginRuntimeGenerationScope(run5) {
  return runOutsidePluginRuntimeGenerationRegistryScope(() => runOutsidePluginMetadataSnapshotScope(() => runOutsidePluginRuntimeRegistryScope(run5)));
}`;
const pristine = `${modelImport}\n${plan}`;
const patchedPlan = () => transform(pristine).replace(/^import .*;\r?\n/gmu, '');

test('verifies the same child model with a fresh inventory while the parent keeps its scope', async () => {
  const inventory = new AsyncLocalStorage<'retired'>();
  const caller = new AsyncLocalStorage<object>();
  const request = {
    cfg: { models: {} },
    targetAgentId: 'child',
    workspaceDir: 'child-workspace',
    model: 'internal/example',
    modelOverrideSource: 'user',
  };
  const identity = {};
  const model = { kind: 'resolved', ref: { provider: 'internal', model: 'example' } };
  const prepareModelChoice = vi.fn(async () => {
    expect(caller.getStore()).toBe(identity);
    if (inventory.getStore() === 'retired') throw new Error('Plugin inventory has retired');
    return model;
  });
  const load = (source: string) => new Function(
    'prepareModelChoice',
    'runOutsidePluginRuntimeGenerationRegistryScope',
    'runOutsidePluginMetadataSnapshotScope',
    'runOutsidePluginRuntimeRegistryScope',
    `${source}\nreturn resolveSubagentModelAndThinkingPlan;`,
  )(prepareModelChoice, (run: () => unknown) => run(), inventory.exit.bind(inventory),
    (run: () => unknown) => run());
  await caller.run(identity, () => inventory.run('retired', async () => {
    expect(await load(`${nativeScope}\n${plan}`)(request)).toMatchObject({
      status: 'error', error: expect.stringContaining('Plugin inventory has retired'),
    });
    prepareModelChoice.mockClear();
    expect(await load(`${nativeScope}\n${patchedPlan()}`)(request)).toBe(model);
    expect(prepareModelChoice).toHaveBeenCalledExactlyOnceWith({
      cfg: request.cfg,
      agentId: request.targetAgentId,
      workspaceDir: request.workspaceDir,
      raw: request.model,
      source: 'override',
    });
    expect(inventory.getStore()).toBe('retired');
  }));
});

test('verifies the source import and the frozen helper binding', () => {
  const source = transform(pristine);
  const bundle = 'gateway-bundle.mjs';
  const initializer = `var init_spawn_thread_binding_CKE2AseF = __esm({
  "dist/spawn-thread-binding-CKE2AseF.mjs"() {
    init_generation_scope_k4t_r2fI();
  }
});`;
  const patchedBundle = `${nativeScope}\n${patchedPlan()}\n${initializer}`
    .replace(/(\/\*RUNTIME_SUBAGENT_MODEL_INVENTORY_V2026_10_7\*\/) /u, '$1\n    ');

  expect(transform(source)).toBe(source);
  expect(transform(patchedBundle, bundle)).toBe(patchedBundle);
  expect(() => transform(source.replace(/^import \{ runOutsidePluginRuntimeGenerationScope.*\r?\n/mu, ''))).toThrow('partial');
  expect(() => transform(patchedBundle.replace('runOutsidePluginRuntimeRegistryScope(run5)', 'run5()'), bundle)).toThrow('native plugin generation isolation changed');
  expect(() => transform(patchedBundle.replace('init_generation_scope_k4t_r2fI();', ''), bundle)).toThrow('missing its plugin generation initializer');
});
