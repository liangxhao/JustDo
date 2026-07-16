import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import GoalStatusCard from './GoalStatusCard';

describe('GoalStatusCard', () => {
  it('renders an optimistic goal with live execution activity', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: null,
        pendingObjective: 'Build a release dashboard',
        progress: { phase: 'tool', startedAt: Date.now(), toolCount: 3, toolName: 'exec' },
        isRunning: true,
        onCommand: vi.fn(),
      }),
    );

    expect(rendered).toContain('Build a release dashboard');
    expect(rendered).toContain('exec');
    expect(rendered).toContain('3');
    expect(rendered).not.toContain('<button');
  });
});
