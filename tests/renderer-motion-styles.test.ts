import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../src/renderer');

const collectRendererSources = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectRendererSources(entryPath);
    if (!/\.(?:css|js|jsx|ts|tsx)$/.test(entry.name)) return [];
    return [entryPath];
  });

describe('renderer motion styles', () => {
  it('does not disable app animations based on OS motion settings', () => {
    const rendererSources = collectRendererSources(rendererRoot)
      .map(filePath => fs.readFileSync(filePath, 'utf8'))
      .join('\n');

    expect(rendererSources).not.toContain('motion-reduce:');
    expect(rendererSources).not.toContain('prefers-reduced-motion');
  });
});
