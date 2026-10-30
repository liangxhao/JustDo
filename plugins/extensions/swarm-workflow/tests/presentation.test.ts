import { expect, test } from 'vitest';

import { presentation } from '../app/presentation';

test('pure entry exposes only presentation and static dictionaries', () => {
  expect(Object.keys(presentation).sort()).toEqual(['text', 'translations']);
  expect(presentation.translations?.en.swarmWorkflowTitle).toBeTruthy();
});
