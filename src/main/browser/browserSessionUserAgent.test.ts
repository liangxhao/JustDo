import { expect, test } from 'vitest';

import { getBrowserUserAgent } from './browserSessionUserAgent';

test.each(['Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10_15_7'])(
  'preserves native platform and Chromium version for %s',
  platform => {
    const prefix = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko)`;
    const expected = `${prefix} Chrome/148.0.7778.280 Safari/537.36`;

    expect(
      getBrowserUserAgent(
        `${prefix} ExampleDesktop/2.0.0-beta.1 Chrome/148.0.7778.280 Electron/42.7.0 Safari/537.36`,
      ),
    ).toBe(expected);
    expect(
      getBrowserUserAgent(`${prefix} Chrome/148.0.7778.280 Electron/42.7.0 Safari/537.36`),
    ).toBe(expected);
    expect(getBrowserUserAgent(expected)).toBe(expected);
  },
);

test('leaves custom browser and mobile user agents unchanged', () => {
  const mobile =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1';
  const custom =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CustomBrowser/2.0 Chrome/148.0.0.0 Safari/537.36';

  expect(getBrowserUserAgent(mobile)).toBe(mobile);
  expect(getBrowserUserAgent(custom)).toBe(custom);
});
