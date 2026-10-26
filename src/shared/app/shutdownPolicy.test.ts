import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { SHUTDOWN_BUDGET_MS as budget } from './shutdownPolicy';
import policy from './shutdownPolicy.json';

test('supervision budgets cover every ordered cleanup and forced-exit observation', () => {
  expect(Object.keys(policy).sort()).toEqual([
    'forceExitObservationMs', 'nativeExitMarginMs', 'nativeShutdownMs',
    'otherAppCleanupMs', 'outerSchedulingMarginMs', 'startupAbortMs',
  ]);
  expect(budget.gatewayGrace).toBe(policy.nativeShutdownMs + policy.nativeExitMarginMs);
  expect(budget.gatewayStop).toBe(budget.gatewayGrace + policy.forceExitObservationMs);
  expect(budget.startupRetirement).toBe(policy.startupAbortMs + policy.forceExitObservationMs);
  expect(budget.applicationCleanup).toBe(budget.startupRetirement + policy.otherAppCleanupMs + budget.gatewayStop);
  expect(budget.applicationExit).toBe(budget.applicationCleanup + policy.outerSchedulingMarginMs);
  expect(budget.launcherGrace).toBe(budget.applicationExit + policy.outerSchedulingMarginMs);
});

test('the frozen startup child defaults fit the shared retirement window', () => {
  const file = 'src/main/startup/upgrade/nativeDatabaseUpgradeRuntime.ts';
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const defaults: Record<string, number[]> = { abortGraceMs: [], retirementObservationMs: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.name.text in defaults && ts.isNumericLiteral(node.right)) {
      defaults[node.left.name.text].push(Number(node.right.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(new Set(defaults.abortGraceMs)).toEqual(new Set([policy.startupAbortMs]));
  expect(new Set(defaults.retirementObservationMs)).toEqual(new Set([policy.forceExitObservationMs]));
});

const explicitRoot = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? process.env.OPENCLAW_TEST_UPSTREAM_ROOT;
const nativeRoot = explicitRoot ?? path.resolve('vendor/openclaw-runtime/current');
const nativeBudget = path.join(nativeRoot, 'gateway-shutdown-budget.mjs');
if (explicitRoot && !fs.existsSync(nativeBudget)) throw new Error('Explicit native shutdown policy is missing.');
test.skipIf(!fs.existsSync(nativeBudget))('the actual locked native budget still matches host supervision', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'package.json'), 'utf8'));
  const target = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).openclaw.version.replace(/^v/u, '');
  expect(pkg.version.replace(/^v/u, '')).toBe(target);
  const native = await import(pathToFileURL(nativeBudget).href);
  expect(native.GATEWAY_SHUTDOWN_TIMEOUT_MS).toBe(policy.nativeShutdownMs);
  expect(native.GATEWAY_SUPERVISOR_EXIT_MARGIN_MS).toBe(policy.nativeExitMarginMs);
  expect(native.GATEWAY_SERVICE_STOP_TIMEOUT_MS).toBe(budget.gatewayGrace);
  expect(native.GATEWAY_SHUTDOWN_RESERVE_MS).toBe(10_000);
  expect(native.GATEWAY_SHUTDOWN_TIMEOUT_MS - native.GATEWAY_SHUTDOWN_RESERVE_MS).toBe(315_000);
});
