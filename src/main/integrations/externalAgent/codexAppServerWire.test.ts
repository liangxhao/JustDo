import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExternalSessionStatus } from '../../../shared/integrations/externalSession';
import {
  codexInitializeResult,
  codexModel,
  codexThread,
  codexThreadOpen,
  codexThreadStatus,
  codexTurn,
  CodexTurnStatus,
} from './codexAppServerWire';
import type { ExternalAgentThreadMetadata } from './externalAgentTypes';

const metadata = (): ExternalAgentThreadMetadata => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Client task',
  cwd: path.resolve('client-project'),
  agentId: 'main',
  modelRef: 'provider/selected',
  permissionMode: 'ask',
  status: ExternalSessionStatus.Completed,
  createdAt: 1_700_000_001_234,
  updatedAt: 1_700_000_009_876,
});

describe('Codex app-server wire projections', () => {
  it('advertises only image support supplied by the configured model catalog', () => {
    expect(codexModel({ id: 'provider/text', name: 'Text', isDefault: false }).inputModalities).toEqual(['text']);
    expect(codexModel({ id: 'provider/vision', name: 'Vision', isDefault: true, inputModalities: ['text', 'image'] }).inputModalities)
      .toEqual(['text', 'image']);
  });
  it('reports the owning home and uses the official Windows platform names', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      const result = codexInitializeResult(path.resolve('application-profile'));

      expect(result).toMatchObject({
        codexHome: path.resolve('application-profile'),
        platformFamily: 'windows',
        platformOs: 'windows',
      });
      expect(result.userAgent).toEqual(expect.stringContaining('/codex-compatible'));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('uses seconds for thread timestamps and keeps native ownership identities private', () => {
    const stored = {
      ...metadata(),
      openclawSessionKey: 'private-native-key',
      nativeSessionId: 'private-native-id',
      lifecycleRevision: 'private-native-revision',
    };

    const result = codexThread(stored);

    expect(result).toMatchObject({
      id: stored.id,
      sessionId: stored.id,
      name: 'Client task',
      createdAt: 1_700_000_001,
      updatedAt: 1_700_000_009,
      recencyAt: 1_700_000_009,
      cwd: stored.cwd,
      model: 'provider/selected',
      modelProvider: 'provider',
      path: null,
      turns: [],
      preview: '',
      status: { type: 'notLoaded' },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-native|lifecycleRevision|openclawSessionKey/);
  });

  it('preserves unresolved work as active metadata rather than inventing a failed execution', () => {
    const unresolved = {
      ...metadata(), status: ExternalSessionStatus.Running, executionState: 'unknown' as const,
    };

    expect(codexThreadStatus(unresolved, true)).toEqual({ type: 'active', activeFlags: [] });
    expect(codexThreadStatus(unresolved, false)).toEqual({ type: 'notLoaded' });
    expect(codexThreadStatus({ ...metadata(), status: ExternalSessionStatus.Error }, true)).toEqual({ type: 'idle' });
  });

  it('reports the selected model override and keeps permission metadata from the stored thread', () => {
    const stored = metadata();
    const result = codexThreadOpen({ ...stored, modelRef: 'other/model' }, stored);

    expect(result).toMatchObject({
      model: 'other/model',
      modelProvider: 'other',
      permissionMode: 'ask',
      approvalPolicy: 'never',
      cwd: stored.cwd,
      thread: { model: 'other/model', modelProvider: 'other', status: { type: 'idle' } },
    });
    expect(codexThreadOpen(stored, stored, true)).toMatchObject({
      approvalPolicy: 'on-request', permissionMode: 'ask', approvalsReviewer: 'user',
    });
    expect(() => codexThreadOpen({ ...stored, modelRef: undefined }, {
      ...stored, modelRef: undefined,
    })).toThrow('model is unavailable');
  });

  it('keeps reasoning defaults managed instead of promising disabled reasoning or overrides', () => {
    const result = codexModel({ id: 'provider/model', name: 'Available model', isDefault: true });

    expect(result).toMatchObject({
      id: 'provider/model',
      model: 'provider/model',
      displayName: 'Available model',
      isDefault: true,
      supportedReasoningEfforts: [],
      inputModalities: ['text'],
      supportsPersonality: false,
    });
    expect(result.defaultReasoningEffort).toBe('default');
    expect(result.defaultReasoningEffort).not.toBe('none');
  });

  it('marks unloaded turn items and distinguishes absent timing from measured duration', () => {
    const running = codexTurn('turn-1', CodexTurnStatus.InProgress, {
      startedAt: 1_700_000_001_234,
    });
    const completed = codexTurn('turn-1', CodexTurnStatus.Completed, {
      startedAt: 1_700_000_001_234,
      completedAt: 1_700_000_003_456,
    });

    expect(running).toMatchObject({
      status: 'inProgress', items: [], itemsView: 'notLoaded',
      startedAt: 1_700_000_001, completedAt: null, durationMs: null, error: null,
    });
    expect(completed).toMatchObject({
      status: 'completed', items: [], itemsView: 'notLoaded',
      startedAt: 1_700_000_001, completedAt: 1_700_000_003, durationMs: 2_222, error: null,
    });
    expect(codexTurn('turn-2', CodexTurnStatus.Interrupted)).toMatchObject({
      status: 'interrupted', startedAt: null, completedAt: null, durationMs: null, error: null,
    });
  });

  it('preserves unknown outcomes without inventing a native error classification or settlement', () => {
    const result = codexTurn('turn-unknown', CodexTurnStatus.Failed, {
      error: 'EXECUTION_UNKNOWN: Native settlement could not be verified.',
    });

    expect(result).toMatchObject({
      id: 'turn-unknown',
      status: 'failed',
      error: {
        message: 'EXECUTION_UNKNOWN: Native settlement could not be verified.',
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    expect(result).not.toHaveProperty('executionSettled');
    expect(result.itemsView).toBe('notLoaded');
  });
});
