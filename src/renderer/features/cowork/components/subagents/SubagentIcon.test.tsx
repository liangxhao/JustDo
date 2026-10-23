import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import SubagentIcon from './SubagentIcon';

const identities = Array.from({ length: 100 }, (_, index) => `agent:main:subagent:sample-${index}`);
const renderIcon = (identity: string, className?: string) =>
  renderToStaticMarkup(<SubagentIcon identity={identity} className={className} />);

function appearance(markup: string) {
  return [
    markup.match(/data-subagent-icon="([^"]+)"/)?.[1],
    markup.match(/data-subagent-palette="([^"]+)"/)?.[1],
  ];
}

describe('SubagentIcon', () => {
  it('keeps established identity assignments stable across implementation changes', () => {
    expect(identities.slice(0, 5).map(identity => appearance(renderIcon(identity)))).toEqual([
      ['orbit', 'purple-indigo'],
      ['aperture', 'emerald-cyan'],
      ['flower', 'teal-pink'],
      ['pinwheel', 'amber-emerald'],
      ['prism', 'indigo-orange'],
    ]);
  });

  it('keeps each identity fixed across ordering, omitted neighbors and render sizes', () => {
    const original = new Map(
      identities.map(identity => [identity, appearance(renderIcon(identity))]),
    );
    for (const identity of [...identities].reverse().filter((_, index) => index % 3 === 0)) {
      expect(appearance(renderIcon(identity, 'h-4 w-4'))).toEqual(original.get(identity));
    }
    expect(renderIcon(identities[0])).toBe(renderIcon(identities[0]));
  });

  it('spreads a hundred similar native IDs across motifs and independent color pairs', () => {
    const icons = identities.map(identity => renderIcon(identity));
    const appearances = icons.map(appearance);

    // Allow occasional collisions; guard against a coupled hash reducing the effective pool.
    expect(new Set(icons).size).toBeGreaterThanOrEqual(95);
    expect(new Set(appearances.map(([motif]) => motif)).size).toBe(24);
    expect(
      new Set(appearances.map(([, palette]) => palette?.split('-')[0])).size,
    ).toBeGreaterThanOrEqual(12);
    expect(
      new Set(appearances.map(([, palette]) => palette?.split('-')[1])).size,
    ).toBeGreaterThanOrEqual(12);
  });

  it('actually paints both colors for every motif and keeps the SVG decorative', () => {
    const motifs = new Map(
      identities.map(identity => {
        const markup = renderIcon(identity);
        return [appearance(markup)[0], markup];
      }),
    );
    expect(motifs.size).toBe(24);
    for (const markup of motifs.values()) {
      const [primary, accent] = appearance(markup)[1]!.split('-');
      expect(primary).not.toBe(accent);
      expect(markup).toContain(`text-${primary}-`);
      expect(markup).toContain('[--subagent-icon-accent:#');
      expect(markup).toMatch(/(?:fill|stroke)="var\(--subagent-icon-accent\)"/);
      expect(markup).toContain('fill="currentColor"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain('focusable="false"');
    }
  });
});
