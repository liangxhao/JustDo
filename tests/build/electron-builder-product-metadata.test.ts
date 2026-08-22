import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  resolveBuilderProductMetadata,
} = require('../../scripts/electron-builder-product-metadata.cjs');

describe('electron-builder product metadata', () => {
  it.each([
    ['JustDo', 'com.justdo.app'],
    ['Wedax', 'com.wedax.app'],
    ['ABC', 'com.abc.app'],
  ])('derives the appId for %s', (productName, appId) => {
    expect(resolveBuilderProductMetadata(productName)).toEqual({ productName, appId });
  });

  it('normalizes productName casing before deriving the appId', () => {
    expect(resolveBuilderProductMetadata('JustDo').appId).toBe(
      resolveBuilderProductMetadata('JUSTDO').appId,
    );
  });

  it.each([undefined, '', 'Wedax App', 'Wedax2', '辅助器', 'con', 'NUL'])(
    'rejects invalid productName %j',
    productName => {
      expect(() => resolveBuilderProductMetadata(productName)).toThrow(/productName/);
    },
  );
});
