// @vitest-environment jsdom

import { COWORK_PLAN_PREVIEW_EVENT } from '@shared/cowork/interactions/planPreview';
import { render } from 'lit';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { renderTimelineItem } from './active-turn-timeline';

describe('PresentPlan timeline card', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test('opens the plan preview with the tool payload', () => {
    const listener = vi.fn();
    window.addEventListener(COWORK_PLAN_PREVIEW_EVENT, listener);
    const host = document.createElement('div');
    document.body.append(host);

    render(
      renderTimelineItem({
        kind: 'plan-presentation',
        key: 'plan:tool-plan',
        item: {
          id: 'tool-plan',
          runId: 'run-1',
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 1,
          updatedAt: 1,
          type: 'tool',
          status: 'completed',
          toolCallId: 'call-plan',
          name: 'presentplan',
          input: { title: 'Ship it', plan: '# Steps\n\n1. Implement' },
        },
      }),
      host,
    );
    host.querySelector<HTMLButtonElement>('[data-plan-presentation-id]')?.click();

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      sourceId: 'tool-plan',
      title: 'Ship it',
      plan: '# Steps\n\n1. Implement',
    });
    window.removeEventListener(COWORK_PLAN_PREVIEW_EVENT, listener);
  });
});
