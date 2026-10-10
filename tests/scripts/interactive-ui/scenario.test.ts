import { describe, expect, it } from 'vitest';

import { scriptJson } from '../../../openclaw-extensions/interactive-ui/document/serialization';
import {
  scenarioContentKind,
  scenarioRendererSource,
} from '../../../openclaw-extensions/interactive-ui/scenario/content-kind';
import { scenarioLabels } from '../../../openclaw-extensions/interactive-ui/scenario/labels';
import {
  calculateScenario,
  MAX_SOURCE_BYTES,
  parseScenario,
  SCENARIO_RESOURCE,
} from '../../../openclaw-extensions/interactive-ui/scenario/schema';

describe('scenario input boundary', () => {
  const fixture = {
    version: 1 as const,
    language: 'zh' as const,
    summary: 'Team investment',
    tasks: [{ label: 'Implementation and testing', hours: 448 }],
    dailyRate: 700,
    budget: 80_000,
    deadline: 21,
    people: 6,
    focus: 6,
  };
  it('projects validated inputs and calculates the documented model', () => {
    expect(parseScenario(JSON.stringify(fixture))).toEqual(fixture);
    expect(calculateScenario(fixture)).toMatchObject({ effort: 448, days: 18, cost: 75_600 });
    expect(calculateScenario(fixture, 10, 7)).toMatchObject({ days: 11, cost: 77_000 });
  });
  it.each([
    { ...fixture, version: 2 },
    { ...fixture, people: '6' },
    { ...fixture, people: 0 },
    { ...fixture, focus: 8.5 },
    { ...fixture, budget: null },
    { ...fixture, url: 'https://example.com' },
    { ...fixture, tasks: [] },
    { ...fixture, tasks: Array(13).fill(fixture.tasks[0]) },
    { ...fixture, tasks: [{ label: 'x', hours: 12, code: 'anything' }] },
    { ...fixture, summary: 'x'.repeat(401) },
    { ...fixture, dailyRate: Infinity },
  ])('rejects unsupported fields, versions, ranges and expressions', value => {
    expect(() => parseScenario(JSON.stringify(value))).toThrow();
  });
  it('rejects oversized Unicode input before parsing', () => {
    expect(() => parseScenario('中'.repeat(MAX_SOURCE_BYTES))).toThrow('Source too large');
  });
  it('keeps injected labels as text and JSON outside script terminators', () => {
    const attack = '</script><script>globalThis.injected=true</script>';
    const source = JSON.stringify({
      ...fixture,
      summary: attack,
      tasks: [{ label: attack, hours: 1 }],
    });
    const html = scenarioContentKind.composeDocument({
      source,
      title: '',
      resourceUrls: { [SCENARIO_RESOURCE]: SCENARIO_RESOURCE },
      promptGranted: false,
    });
    expect(html).not.toContain(attack);
    expect(html).toContain('&lt;/script&gt;');
    expect(scriptJson({ value: attack + '\u2028\u2029' })).not.toMatch(/[<\u2028\u2029]/);
    expect(JSON.parse(scriptJson({ value: attack }))).toEqual({ value: attack });
    expect(html.match(/<script/g)).toHaveLength(2);
  });
  it('serves only its fixed renderer and requires a scoped resource URL', async () => {
    expect(await scenarioContentKind.resources.readPublicResource('/unknown')).toBeUndefined();
    expect(await scenarioContentKind.resources.readPublicResource(SCENARIO_RESOURCE)).toBeDefined();
    expect(() =>
      scenarioContentKind.composeDocument({
        source: JSON.stringify(fixture),
        title: '',
        resourceUrls: {},
        promptGranted: false,
      }),
    ).toThrow();
    expect(() => new Function(scenarioRendererSource())).not.toThrow();
  });
  it('keeps both language dictionaries complete', () => {
    expect(Object.keys(scenarioLabels.zh).sort()).toEqual(Object.keys(scenarioLabels.en).sort());
  });
});
