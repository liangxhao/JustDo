import fs from 'node:fs';

import { expect, test } from 'vitest';

import { htmlPageContentKind } from '../../../plugins/extensions/widget-kit/document/content-kind';
import { HTML_PAGE_KIND } from '../../../plugins/extensions/widget-kit/document/contracts';

test('published HTML page call uses raw markup accepted by the registered kind', () => {
  const reference = fs.readFileSync(
    'plugins/extensions/widget-kit/skills/visualize/references/pinned-network.md',
    'utf8',
  );
  const examples = [...reference.matchAll(/```json\s*([\s\S]*?)```/g)];
  expect(examples).toHaveLength(1);
  for (const [, example] of examples) {
    const document = JSON.parse(example);
    expect(document.kind).toBe(HTML_PAGE_KIND);
    expect(document.pin).toBe(true);
    expect(document.widget_code).toContain('<img');
    expect(() => htmlPageContentKind.validateSource(document.widget_code)).not.toThrow();
  }
});
