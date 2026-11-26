import {
  buildModelConnectionTestRequestBody,
  BuiltinModelProbeOutcome,
  type BuiltinModelProbeResult,
  MODEL_CONNECTION_TEST_MAX_TOKENS,
  NetworkFetchPurpose,
} from '@shared/network/network';
import type { BuiltinModelAuthIssue } from '@shared/providers/builtinModels';
import { mergeModelProviderHeaders } from '@shared/providers/modelProviderHeaders';
import { buildOpenAIJsonRequestHeaders } from '@shared/providers/modelRequestHeaders';
import React from 'react';

import { getProviderDisplayName, isBuiltinModelsProvider } from '@/app/config';
import {
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  selectModelsForConnectionTest,
  withModelConnectionTestTimeout,
} from '@/features/settings/models/modelConnectionTest';
import { i18nService } from '@/services/i18n';

import {
  getConnectivityErrorMessage,
  ModelConnectionTestResult,
  ModelConnectionTestStatus,
  ProviderConnectionTestResult,
  providerRequiresApiKey,
  ProvidersConfig,
  ProviderType,
  resolveBaseUrl,
  toConnectivityRecord,
} from './providerSettingsConfig';

const waitForNextPaint = () =>
  new Promise<void>(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });

const stringifyConnectivityLogValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isValidConnectivityResponse = (data: unknown): boolean => {
  const record = toConnectivityRecord(data);
  if (!record || record.error) {
    return false;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  return choices.some(choice => {
    const choiceRecord = toConnectivityRecord(choice);
    if (!choiceRecord) {
      return false;
    }

    const message = toConnectivityRecord(choiceRecord.message);
    const delta = toConnectivityRecord(choiceRecord.delta);
    const hasContent =
      (typeof message?.content === 'string' && message.content.length > 0) ||
      (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) ||
      (typeof delta?.content === 'string' && delta.content.length > 0) ||
      (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
      (typeof choiceRecord.text === 'string' && choiceRecord.text.length > 0);
    const hasToolCalls =
      Array.isArray(message?.tool_calls) ||
      Array.isArray(delta?.tool_calls) ||
      typeof message?.function_call === 'object';
    const reachedTokenLimit = choiceRecord.finish_reason === 'length';

    return hasContent || hasToolCalls || reachedTokenLimit;
  });
};

interface ModelConnectionTestActionsOptions {
  providers: ProvidersConfig;
  setTestResult: React.Dispatch<React.SetStateAction<ProviderConnectionTestResult | null>>;
  setIsTestResultModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setModelConnectionTestStatuses: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, ModelConnectionTestStatus>>>
  >;
  setProviders: React.Dispatch<React.SetStateAction<ProvidersConfig>>;
  cancelConnectionTest: (updateState?: boolean) => void;
  activeProvider: string;
  connectionTestRef: React.MutableRefObject<{ generation: number; requestId: string | null }>;
  setIsTesting: React.Dispatch<React.SetStateAction<boolean>>;
  isDetectingModels: boolean;
  enableProvider: (provider: ProviderType) => void;
  onAuthenticationRejected: (issue: BuiltinModelAuthIssue) => void;
}

export function createModelConnectionTestActions({
  providers,
  setTestResult,
  setIsTestResultModalOpen,
  setModelConnectionTestStatuses,
  setProviders,
  cancelConnectionTest,
  activeProvider,
  connectionTestRef,
  setIsTesting,
  isDetectingModels,
  enableProvider,
  onAuthenticationRejected,
}: ModelConnectionTestActionsOptions) {
  const showTestResultModal = (
    result: Omit<ProviderConnectionTestResult, 'provider' | 'providerName'>,
    provider: ProviderType,
  ) => {
    const providerConfig = providers[provider];
    setTestResult({
      ...result,
      provider,
      providerName: getProviderDisplayName(provider, providerConfig),
    });
    setIsTestResultModalOpen(true);
  };

  const updateConnectionTestModelResult = (
    modelId: string,
    nextResult: ModelConnectionTestResult,
  ) => {
    setTestResult(current => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        modelResults: current.modelResults?.map(result =>
          result.modelId === modelId ? nextResult : result,
        ),
      };
    });
  };

  const applyModelConnectionTestOutcome = (
    provider: ProviderType,
    result: ModelConnectionTestResult,
  ) => {
    const status: ModelConnectionTestStatus = result.success ? 'success' : 'failed';
    setModelConnectionTestStatuses(current => ({
      ...current,
      [provider]: {
        ...current[provider],
        [result.modelId]: status,
      },
    }));
    if (!result.success && !isBuiltinModelsProvider(provider)) {
      setProviders(current => ({
        ...current,
        [provider]: {
          ...current[provider],
          models: (current[provider].models ?? []).map(model =>
            model.id === result.modelId ? { ...model, enabled: false } : model,
          ),
        },
      }));
    }
  };

  // 测试 API 连接
  const handleTestConnection = async (modelId?: string) => {
    cancelConnectionTest();
    const testingProvider = activeProvider;
    const builtinProvider = isBuiltinModelsProvider(testingProvider);
    const providerConfig = providers[testingProvider];
    const testGeneration = connectionTestRef.current.generation;
    const isCurrentTest = () => connectionTestRef.current.generation === testGeneration;
    setIsTesting(true);
    setTestResult(null);
    if (!builtinProvider) {
      setModelConnectionTestStatuses(current => ({
        ...current,
        [testingProvider]: modelId
          ? Object.fromEntries(
              Object.entries(current[testingProvider] ?? {}).filter(
                ([testedModelId]) => testedModelId !== modelId,
              ),
            )
          : {},
      }));
    }

    // Check if provider has valid authentication
    if (
      (providerRequiresApiKey(testingProvider) &&
        (!providerConfig.apiKey.trim() || !providerConfig.baseUrl.trim())) ||
      isDetectingModels
    ) {
      setIsTesting(false);
      connectionTestRef.current.requestId = null;
      return;
    }

    const originalModels = providerConfig.models ?? [];
    if (originalModels.length === 0) {
      showTestResultModal(
        { status: 'failed', message: i18nService.t('noModelsConfigured') },
        testingProvider,
      );
      setIsTesting(false);
      connectionTestRef.current.requestId = null;
      return;
    }

    const modelsToTest = selectModelsForConnectionTest(originalModels, modelId).map(model => ({
      ...model,
    }));
    if (modelsToTest.length === 0) {
      setIsTesting(false);
      connectionTestRef.current.requestId = null;
      return;
    }

    const baseUrl = builtinProvider
      ? undefined
      : resolveBaseUrl(testingProvider, providerConfig.baseUrl).replace(/\/+$/, '');
    const openaiUrl = baseUrl === undefined ? undefined : `${baseUrl}/chat/completions`;
    const requestLog = openaiUrl === undefined ? [] : [`${i18nService.t('testRequestUrl')}: ${openaiUrl}`];
    try {
      showTestResultModal(
        {
          status: 'testing',
          message: i18nService.t('testing'),
          baseUrl,
          modelResults: modelsToTest.map(model => ({
            success: false,
            status: 'pending',
            modelLabel: model.name?.trim() || model.id,
            modelId: model.id,
            detail: i18nService.t('connectionTestPending'),
          })),
        },
        testingProvider,
      );

      const results: ModelConnectionTestResult[] = [];
      for (const model of modelsToTest) {
        if (!isCurrentTest()) {
          return;
        }
        const modelLabel = model.name?.trim() || model.id;
        updateConnectionTestModelResult(model.id, {
          success: false,
          status: 'testing',
          modelLabel,
          modelId: model.id,
          detail: i18nService.t('connectionTestRunning'),
        });
        await waitForNextPaint();
        if (!isCurrentTest()) {
          return;
        }

        const requestId = `model-connection-test-${crypto.randomUUID()}`;
        connectionTestRef.current.requestId = requestId;

        try {
          let request: Promise<BuiltinModelProbeResult>;
          if (openaiUrl === undefined) {
            request = window.electron.api.testBuiltinModel({ modelId: model.id, requestId })
              .catch(() => ({ outcome: BuiltinModelProbeOutcome.Interrupted }));
          } else {
            const body = buildModelConnectionTestRequestBody(model.id, MODEL_CONNECTION_TEST_MAX_TOKENS);
            const headers = mergeModelProviderHeaders(
              buildOpenAIJsonRequestHeaders(body, providerConfig.apiKey, { includeContentLength: false }),
              providerConfig.headers,
            );
            request = window.electron.api.fetch({
              url: openaiUrl, method: 'POST', headers, body, requestId,
              purpose: NetworkFetchPurpose.ModelConnectionTest,
            }).then(response => ({ outcome: BuiltinModelProbeOutcome.Completed, response }));
          }
          const outcome = await withModelConnectionTestTimeout(
            request,
            () => window.electron.api.cancelFetch(requestId),
            i18nService
              .t('connectionTestTimeout')
              .replace('{seconds}', String(MODEL_CONNECTION_TEST_TIMEOUT_MS / 1000)),
          );
          if (!isCurrentTest()) {
            return;
          }
          if (connectionTestRef.current.requestId === requestId) {
            connectionTestRef.current.requestId = null;
          }
          if (outcome.outcome !== BuiltinModelProbeOutcome.Completed) {
            if (outcome.outcome === BuiltinModelProbeOutcome.AuthenticationRejected) {
              onAuthenticationRejected(outcome.issue);
            }
            break;
          }
          const { response } = outcome;
          const data = response.data || {};
          if (response.ok && isValidConnectivityResponse(data)) {
            const nextResult: ModelConnectionTestResult = {
              success: true,
              status: 'success',
              modelLabel,
              modelId: model.id,
              detail: i18nService.t('connectionSuccess'),
            };
            results.push(nextResult);
            updateConnectionTestModelResult(model.id, nextResult);
            applyModelConnectionTestOutcome(testingProvider, nextResult);
            continue;
          }

          const errorMessage =
            getConnectivityErrorMessage(data) ||
            (response.ok
              ? i18nService.t('connectionInvalidResponse')
              : response.status > 0
                ? `${i18nService.t('connectionFailed')}: ${response.status}`
                : response.error || i18nService.t('connectionFailed'));
          const recovered =
            !response.ok &&
            typeof errorMessage === 'string' &&
            errorMessage.toLowerCase().includes('model output limit was reached');

          const nextResult: ModelConnectionTestResult = {
            success: recovered,
            status: recovered ? 'success' : 'failed',
            modelLabel,
            modelId: model.id,
            detail: recovered ? i18nService.t('connectionSuccess') : errorMessage,
            log: [
              ...requestLog,
              `${i18nService.t('testModel')}: ${modelLabel} (${model.id})`,
              ...(response.status > 0 ? [`${i18nService.t('testStatus')}: ${response.status}`] : []),
              `${i18nService.t('testResponse')}: ${stringifyConnectivityLogValue(data)}`,
            ].join('\n'),
          };
          results.push(nextResult);
          updateConnectionTestModelResult(model.id, nextResult);
          applyModelConnectionTestOutcome(testingProvider, nextResult);
        } catch (err) {
          if (!isCurrentTest()) {
            return;
          }
          if (connectionTestRef.current.requestId === requestId) {
            connectionTestRef.current.requestId = null;
          }
          const nextResult: ModelConnectionTestResult = {
            success: false,
            status: 'failed',
            modelLabel,
            modelId: model.id,
            detail: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
            log: [
              ...requestLog,
              `${i18nService.t('testModel')}: ${modelLabel} (${model.id})`,
              `${i18nService.t('testError')}: ${
                err instanceof Error ? err.stack || err.message : stringifyConnectivityLogValue(err)
              }`,
            ].join('\n'),
          };
          results.push(nextResult);
          updateConnectionTestModelResult(model.id, nextResult);
          applyModelConnectionTestOutcome(testingProvider, nextResult);
        }
      }

      if (!isCurrentTest()) {
        return;
      }
      if (results.length === 0) {
        setIsTestResultModalOpen(false);
        setTestResult(null);
        return;
      }

      const passedCount = results.filter(result => result.success).length;
      const allPassed = passedCount === modelsToTest.length;
      const hasFailure = passedCount !== results.length;
      if (allPassed) {
        enableProvider(testingProvider);
      }

      showTestResultModal(
        {
          status: allPassed ? 'success' : hasFailure ? 'failed' : undefined,
          message: `${i18nService
            .t('connectionTestSummary')
            .replace('{tested}', String(results.length))
            .replace(
              '{total}',
              String(modelsToTest.length),
            )}${allPassed ? `\n${i18nService.t('connectionSuccess')}` : ''}`,
          baseUrl,
          modelResults: results,
          log: results
            .map(result =>
              [
                `${result.success ? 'PASS' : 'FAIL'} ${result.modelLabel} (${result.modelId})`,
                result.detail,
                result.log ? result.log : null,
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n'),
        },
        testingProvider,
      );
    } catch (err) {
      if (!isCurrentTest()) {
        return;
      }
      showTestResultModal(
        {
          status: 'failed',
          message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
          baseUrl,
          modelLabel: modelsToTest[0]?.name?.trim() || modelsToTest[0]?.id,
          modelId: modelsToTest[0]?.id,
          log: [
            ...requestLog,
            `${i18nService.t('testModel')}: ${modelsToTest[0]?.name?.trim() || modelsToTest[0]?.id} (${modelsToTest[0]?.id})`,
            `${i18nService.t('testError')}: ${
              err instanceof Error ? err.stack || err.message : stringifyConnectivityLogValue(err)
            }`,
          ].join('\n'),
        },
        testingProvider,
      );
    } finally {
      if (isCurrentTest()) {
        connectionTestRef.current.requestId = null;
        setIsTesting(false);
      }
    }
  };
  return { handleTestConnection };
}
