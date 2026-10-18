import { describe, expect, it } from 'vitest';

import { mcpToolHasApp } from './mcpAppCapabilities';

describe('MCP interactive interface capability', () => {
  it('recognizes standard, native projected and legacy tool UI metadata', () => {
    expect(mcpToolHasApp({ _meta: { ui: { resourceUri: 'ui://example/view' } } })).toBe(true);
    expect(mcpToolHasApp({ uiResourceUri: 'ui://example/view' })).toBe(true);
    expect(mcpToolHasApp({ _meta: { 'ui/resourceUri': 'ui://example/view' } })).toBe(true);
  });
  it.each([
    undefined,
    {},
    { name: 'drawio' },
    { resources: true },
    { entrypoints: [{ type: 'global' }] },
    { _meta: { ui: { resourceUri: 'https://example.test/view' } } },
    { uiResourceUri: ' ui://example/view' },
  ])('does not infer UI from unrelated metadata (%j)', value => {
    expect(mcpToolHasApp(value)).toBe(false);
  });
});
