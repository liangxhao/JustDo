import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { buildSwarmInstruction, stripSwarmInstruction } from '@shared/cowork/swarm';
import { expect, test } from 'vitest';

import { parseEditorDraftPayload } from '../model/editor-draft';
import { normalizeMessage } from './message-normalizer';

test('keeps native instructions out of user message display and editor drafts', () => {
  const text =
    'Review this project' + '\n\n' + buildSwarmInstruction({ mode: 'review', verify: true });
  expect(stripSwarmInstruction(text)).toBe('Review this project');
  expect(parseEditorDraftPayload(text, []).text).toBe('Review this project');
  expect(normalizeMessage({ role: 'user', content: text }).content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Review this project' }),
    ]),
  );
});
test('does not hide user-authored tags, similar prose, or embedded snippets', () => {
  const text = 'Explain <parallel-collaboration-request>hello</parallel-collaboration-request>';
  expect(stripSwarmInstruction(text)).toBe(text);
  const snippet = buildSwarmInstruction({ mode: 'auto', verify: false }) + '\nExplain this';
  expect(stripSwarmInstruction(snippet)).toBe(snippet);
});
test('preserves browser annotation transport when removing the exact Swarm suffix', () => {
  const browser = composeBrowserGatewayPrompt('Review page', []);
  expect(
    stripSwarmInstruction(
      browser + '\n\n' + buildSwarmInstruction({ mode: 'research', verify: false }),
    ),
  ).toBe(browser);
});
