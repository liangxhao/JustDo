import { describe, expect, it } from 'vitest';

import packageJson from '../../package.json';
import {
  DEFAULT_WORKSPACE_DIRECTORY_NAME,
  PRODUCT_NAME,
  USER_DATA_DIRECTORY_NAME,
  validateProductName,
} from './productMetadata';

describe('product metadata', () => {
  it('derives external names from package.json without changing internal package identity', () => {
    expect(PRODUCT_NAME).toBe(packageJson.productName);
    expect(USER_DATA_DIRECTORY_NAME).toBe(packageJson.productName);
    expect(DEFAULT_WORKSPACE_DIRECTORY_NAME).toBe(
      packageJson.productName.toLocaleLowerCase('en-US'),
    );
    expect(packageJson.name).toBe('justdo');
  });

  it.each([
    '',
    ' JustDo',
    'JustDo ',
    'Just Do',
    'Just-Do',
    'Just_Do',
    'JustDo2',
    '公司助手',
    'Café',
    '.',
    '..',
    'A/B',
    'A\\B',
    'A.',
    'CON',
    'LPT1.txt',
    'A'.repeat(65),
  ])(
    'rejects an unsafe cross-platform path segment: %j',
    value => {
      expect(() => validateProductName(value)).toThrow(/productName/);
    },
  );

  it.each(['JustDo', 'Company', 'INTERNAL', 'assistant'])(
    'accepts a single English word: %s',
    value => {
      expect(validateProductName(value)).toBe(value);
    },
  );
});
