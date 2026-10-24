import fs from 'node:fs';

import { expect, test } from 'vitest';

import { parseOfflineHtmlDocument } from '../../../plugins/extensions/widget-kit/libraries/schema';

test('published offline-library source and tool examples pass the same admission parser', () => {
  const reference = fs.readFileSync(
    'plugins/extensions/widget-kit/skills/visualize/references/offline-libraries.md',
    'utf8',
  );
  const examples = [...reference.matchAll(/```json\s*([\s\S]*?)```/g)];
  expect(examples).toHaveLength(2);
  for (const [, example] of examples) {
    const document = JSON.parse(example);
    const source = 'widget_code' in document ? document.widget_code : JSON.stringify(document);
    if ('widget_code' in document) expect(document.kind).toBe('offline-html');
    expect(parseOfflineHtmlDocument(source).libraries).toEqual(['echarts']);
  }
});
