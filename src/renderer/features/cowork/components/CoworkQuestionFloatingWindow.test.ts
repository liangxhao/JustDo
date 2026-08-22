import { CoworkInteractionKind } from '@shared/openclaw/extensions';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

import CoworkInteractionModal from './CoworkInteractionModal';
import CoworkQuestionFloatingWindow, {
  clampQuestionWindowOffset,
  hasMultipleAskUserQuestions,
  resolveQuestionWindowOffsetCorrection,
  shouldShowCoworkQuestionWindow,
} from './CoworkQuestionFloatingWindow';

const buildInteraction = (questionCount: number): CoworkInteractionRequest => ({
  sessionId: 'session-1',
  requestId: 'request-1',
  toolName: 'AskUserQuestion',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolInput: {
    questions: Array.from({ length: questionCount }, (_, index) => ({
      id: `question_${index + 1}`,
      question: `Question ${index + 1}`,
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    })),
  },
});

describe('CoworkQuestionFloatingWindow', () => {
  it.each([
    [1, 'max-w-lg'],
    [2, 'max-w-2xl'],
  ])('keeps the original centered width for %i-question requests', (questionCount, widthClass) => {
    const html = renderToStaticMarkup(
      React.createElement(CoworkQuestionFloatingWindow, {
        interaction: buildInteraction(questionCount as number),
        isVisible: true,
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain('data-cowork-question-floating-window');
    expect(html).toContain('fixed inset-0');
    expect(html).toContain('items-center justify-center');
    expect(html).toContain(widthClass);
    expect(html).toContain('pointer-events-none');
    expect(html).toContain('pointer-events-auto');
    expect(html).toContain('data-question-drag-handle="true"');
    expect(html).not.toContain('modal-backdrop');
    expect(html).not.toContain('aria-modal="true"');
  });

  it('uses the wizard only when multiple valid questions are present', () => {
    expect(hasMultipleAskUserQuestions(buildInteraction(1))).toBe(false);
    expect(hasMultipleAskUserQuestions(buildInteraction(2))).toBe(true);
  });

  it('is visible only while its owning session is the active cowork session', () => {
    expect(shouldShowCoworkQuestionWindow('session-1', 'session-1', true)).toBe(true);
    expect(shouldShowCoworkQuestionWindow('session-1', 'session-2', true)).toBe(false);
    expect(shouldShowCoworkQuestionWindow('session-1', 'session-1', false)).toBe(false);

    const html = renderToStaticMarkup(
      React.createElement(CoworkQuestionFloatingWindow, {
        interaction: buildInteraction(1),
        isVisible: false,
        onRespond: vi.fn(),
      }),
    );
    expect(html).toContain('hidden');
    expect(html).toContain('aria-hidden="true"');
  });

  it('clamps dragging offsets to the visible viewport bounds', () => {
    expect(clampQuestionWindowOffset(-20, -10, 30)).toBe(-10);
    expect(clampQuestionWindowOffset(12, -10, 30)).toBe(12);
    expect(clampQuestionWindowOffset(45, -10, 30)).toBe(30);
  });

  it('corrects the position when dynamic content growth moves the window outside the viewport', () => {
    expect(
      resolveQuestionWindowOffsetCorrection(
        { left: 20, right: 510, top: 30, bottom: 650 },
        { width: 500, height: 600 },
      ),
    ).toEqual({ x: -18, y: -58 });
    expect(
      resolveQuestionWindowOffsetCorrection(
        { left: 20, right: 480, top: 30, bottom: 560 },
        { width: 500, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it('keeps non-question interactions modal', () => {
    const html = renderToStaticMarkup(
      React.createElement(CoworkInteractionModal, {
        interaction: {
          ...buildInteraction(1),
          interactionKind: undefined,
          toolName: 'SomeOtherTool',
        },
        onRespond: vi.fn(),
      }),
    );

    expect(html).toContain('modal-backdrop');
    expect(html).toContain('aria-modal="true"');
  });
});
