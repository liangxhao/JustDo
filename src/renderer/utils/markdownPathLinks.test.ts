import { expect, test } from 'vitest';

import { matchAutoLinkPathPrefix } from './markdownPathLinks';

test('does not treat URL authority and path as a local POSIX path', () => {
  expect(matchAutoLinkPathPrefix('//example.com/docs/start')).toBeNull();
});

test('matches supported local file path prefixes', () => {
  expect(matchAutoLinkPathPrefix('/home/user/docs/readme.md')).toBe(
    '/home/user/docs/readme.md',
  );
  expect(matchAutoLinkPathPrefix('C:\\Users\\user\\readme.md')).toBe(
    'C:\\Users\\user\\readme.md',
  );
  expect(matchAutoLinkPathPrefix('file:///home/user/readme.md')).toBe(
    'file:///home/user/readme.md',
  );
});
