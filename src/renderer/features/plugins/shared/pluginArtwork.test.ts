import { expect, test } from 'vitest';

import { getPluginArtworkTone } from './pluginArtwork';

test('keeps the fallback artwork tone stable for an item', () => {
  expect(getPluginArtworkTone('plugin-a')).toBe(getPluginArtworkTone('plugin-a'));
});

test('spreads tones across adjacent positions in a two-column grid', () => {
  const tones = Array.from({ length: 32 }, (_, index) =>
    getPluginArtworkTone('system-extensions', index),
  );

  for (let index = 0; index < tones.length; index += 1) {
    if (index > 0) expect(tones[index]).not.toBe(tones[index - 1]);
    if (index > 1) expect(tones[index]).not.toBe(tones[index - 2]);
  }

  expect(new Set(tones)).toHaveLength(16);
  expect(tones[0]).toBe(tones[16]);
});
