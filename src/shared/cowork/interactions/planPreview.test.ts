import { describe, expect, test } from 'vitest';

import { extractPresentPlanPreview, isCoworkPlanPreview } from './planPreview';

describe('planPreview', () => {
  test('extracts a trimmed PresentPlan payload', () => {
    expect(
      extractPresentPlanPreview(
        'PresentPlan',
        { title: ' Release ', plan: ' # Steps\n ' },
        'tool-1',
      ),
    ).toEqual({ sourceId: 'tool-1', title: 'Release', plan: '# Steps' });
  });

  test('rejects other tools and empty plans', () => {
    expect(extractPresentPlanPreview('read', { plan: '# Steps' }, 'tool-1')).toBeNull();
    expect(extractPresentPlanPreview('PresentPlan', { plan: '  ' }, 'tool-1')).toBeNull();
    expect(isCoworkPlanPreview({ sourceId: 'tool-1', plan: '' })).toBe(false);
  });
});
