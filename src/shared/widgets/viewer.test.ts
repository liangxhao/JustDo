import { describe, expect, it } from 'vitest';

import { widgetViewerMount } from './viewer';

const mount = '2e4ec192-521e-4b76-b132-e34598e41bb2';
const owner = 'http://127.0.0.1:43127/workspace.html';
const url = `http://127.0.0.1:43127/widget-viewer.html?mount=${mount}`;
describe('widget viewer admission', () => {
  it('admits only the fixed page on the current application origin', () => {
    expect(widgetViewerMount(url, owner)).toBe(mount);
    for (const invalid of [
      url.replace(':43127', ':43128'),
      url + '&extra=1',
      url + '#fragment',
      url.replace('widget-viewer', 'workspace'),
      url.replace(mount, 'bad'),
      url.replace('127.0.0.1', 'user@127.0.0.1'),
    ])
      expect(widgetViewerMount(invalid, owner)).toBeUndefined();
    expect(widgetViewerMount(url, 'file:///index.html')).toBeUndefined();
  });
});
