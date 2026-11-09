import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

// Exercise the final production failure callback without mounting the whole view.
const source = ts.createSourceFile(
  'CoworkView.tsx',
  readFileSync(path.resolve(__dirname, '../CoworkView.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const failureCallbacks: ts.Expression[] = [];
function collectFailureCallbacks(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'submitCoworkMessage')
    failureCallbacks.push(node.arguments[1]);
  ts.forEachChild(node, collectFailureCallbacks);
}
function findSendHandler(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handleSendMessage' && node.initializer) {
    collectFailureCallbacks(node.initializer);
    return;
  }
  ts.forEachChild(node, findSendHandler);
}
findSendHandler(source);
if (failureCallbacks.length !== 1)
  throw new Error(`Expected one session send failure callback, found ${failureCallbacks.length}.`);
const callbackScript = ts.transpileModule(`(${failureCallbacks[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test.each([
  { language: 'zh' as const, error: 'fixturePluginAdmissionFailed', unknown: false, display: '扩展请求尚未完成核实。' },
  { language: 'en' as const, error: 'fixturePluginAdmissionFailed', unknown: false, display: 'The extension request is still being verified.' },
  { language: 'en' as const, error: 'Native session: permission denied (EACCES)', unknown: false, display: 'Native session: permission denied (EACCES)' },
  { language: 'en' as const, error: 'fixturePluginAdmissionFailed', unknown: true, display: '' },
])('presents a follow-up failure in the current locale without changing its admission state: $language/$unknown/$error', async scenario => {
  const previousLanguage = i18nService.getLanguage();
  const release = i18nService.registerPluginTranslations('send-error-fixture', {
    en: { fixturePluginAdmissionFailed: 'The extension request is still being verified.' },
    zh: { fixturePluginAdmissionFailed: '扩展请求尚未完成核实。' },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const dispatchEvent = vi.fn();
  const abort = vi.fn().mockResolvedValue({ success: true });
  const failSessionRun = vi.fn();
  const refreshSessionRuntimeActivity = vi.fn();
  const operation = { cancelled: false };
  class ToastEvent {
    constructor(public readonly type: string, public readonly init: { detail: string }) {}
    get detail() { return this.init.detail; }
  }
  const error = Object.assign(new Error(scenario.error), { code: 'NATIVE_ADMISSION_REJECTED' });
  try {
    i18nService.setLanguage(scenario.language, { persist: false });
    const onFailure = runInNewContext(callbackScript, {
      operation, explicitPlugin: true, nativeSendIssued: false,
      currentSession: { id: 'source' }, clientTurnId: 'exact-client',
      runTimingId: 'receipt', requestUnknown: scenario.unknown, goalEdit: false,
      coworkService: { failSessionRun, refreshSessionRuntimeActivity },
      window: { dispatchEvent, electron: { cowork: { abortPluginSubmissionBeforeSend: abort } } },
      CustomEvent: ToastEvent, Error, i18nService,
    }) as (error: Error) => Promise<void>;
    await onFailure(error);

    const detail = scenario.unknown
      ? i18nService.t('coworkSendOutcomeUnknown')
      : i18nService.t('coworkErrorSessionStartFailed').replace('{error}', scenario.display);
    expect(dispatchEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'app:showToast', detail }),
    );
    expect(error.message).toBe(scenario.error);
    expect(error.code).toBe('NATIVE_ADMISSION_REJECTED');
    expect(operation.cancelled).toBe(true);
    expect(abort).toHaveBeenCalledExactlyOnceWith({ sessionId: 'source', clientTurnId: 'exact-client' });
    expect(failSessionRun).toHaveBeenCalledTimes(scenario.unknown ? 0 : 1);
    expect(refreshSessionRuntimeActivity).toHaveBeenCalledTimes(scenario.unknown ? 1 : 0);
  } finally {
    release();
    i18nService.setLanguage(previousLanguage, { persist: false });
    warn.mockRestore();
  }
});
