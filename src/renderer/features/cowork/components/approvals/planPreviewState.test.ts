import { describe, expect, test } from 'vitest';

import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

import {
  initialPlanPreviewState,
  planPreviewReducer,
  retainedPlanForSession,
} from './planPreviewState';

const plan = (sessionId: string, requestId: string): CoworkInteractionRequest => ({
  sessionId,
  requestId,
  toolName: 'PresentPlan',
  interactionKind: 'plan-approval',
  toolInput: { plan: `# ${requestId}` },
});

describe('planPreviewState', () => {
  test('retains a plan only after implementation starts', () => {
    const pending = planPreviewReducer(initialPlanPreviewState, {
      type: 'pending-shown',
      sessionId: 'session-a',
    });
    expect(retainedPlanForSession(pending, 'session-a')).toBeNull();

    const implementing = planPreviewReducer(pending, {
      type: 'implementation-started',
      interaction: plan('session-a', 'plan-a'),
    });
    expect(retainedPlanForSession(implementing, 'session-a')?.requestId).toBe('plan-a');
  });

  test('retains an optimistic preview while implementation admission is uncertain', () => {
    const implementing = planPreviewReducer(initialPlanPreviewState, {
      type: 'implementation-started',
      interaction: plan('session-a', 'plan-a'),
    });

    expect(retainedPlanForSession(implementing, 'session-a')?.requestId).toBe('plan-a');
  });

  test('keeps retained plans isolated by session and allows reopening', () => {
    const sessionA = planPreviewReducer(initialPlanPreviewState, {
      type: 'preview-opened',
      interaction: plan('session-a', 'plan-a'),
    });
    expect(retainedPlanForSession(sessionA, 'session-b')).toBeNull();

    const closed = planPreviewReducer(sessionA, { type: 'closed' });
    expect(retainedPlanForSession(closed, 'session-a')).toBeNull();

    const reopened = planPreviewReducer(closed, {
      type: 'preview-opened',
      interaction: plan('session-a', 'plan-a'),
    });
    expect(retainedPlanForSession(reopened, 'session-a')?.requestId).toBe('plan-a');
  });

  test('clears an older preview when a new pending plan appears or is resolved', () => {
    const oldPreview = planPreviewReducer(initialPlanPreviewState, {
      type: 'preview-opened',
      interaction: plan('session-a', 'plan-old'),
    });
    const pending = planPreviewReducer(oldPreview, {
      type: 'pending-shown',
      sessionId: 'session-a',
    });
    expect(retainedPlanForSession(pending, 'session-a')).toBeNull();

    const resolved = planPreviewReducer(pending, {
      type: 'resolved-without-implementation',
      sessionId: 'session-a',
    });
    expect(resolved.openSessionId).toBeNull();
  });
});
