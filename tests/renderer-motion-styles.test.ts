import fs from 'node:fs';
import path from 'node:path';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../src/renderer');

const collectRendererSources = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectRendererSources(entryPath);
    if (!entry.name.endsWith('.css')) return [];
    return [entryPath];
  });

describe('renderer motion styles', () => {
  it('does not globally disable motion while allowing component-scoped accessibility styles', () => {
    // Current UI design supports reduced motion for decorative transitions.
    // Protect against the old blanket override, not those scoped adaptations.
    const globalOverrides: string[] = [];
    for (const filePath of collectRendererSources(rendererRoot)) {
      const css = postcss.parse(fs.readFileSync(filePath, 'utf8'), { from: filePath });
      css.walkAtRules('media', media => {
        if (!media.params.includes('prefers-reduced-motion')) return;
        media.walkRules(rule => {
          const targetsWholeApp = rule.selectors.some(selector =>
            /^(?:\*|html|body|:root)(?:(?:::?[\w-]+)|\s+\*)*$/.test(selector.trim()),
          );
          if (!targetsWholeApp) return;
          rule.walkDecls(/^(?:animation|transition)(?:-|$)/, declaration => {
            globalOverrides.push(`${path.relative(rendererRoot, filePath)}: ${rule.selector}: ${declaration}`);
          });
        });
      });
    }
    expect(globalOverrides).toEqual([]);
  });
});
