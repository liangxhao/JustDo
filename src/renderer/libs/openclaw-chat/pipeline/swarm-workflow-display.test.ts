import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { buildSwarmWorkflowInstruction, stripSwarmWorkflowInstruction } from '@shared/cowork/swarmWorkflow';
import { expect, test } from 'vitest';

import { parseEditorDraftPayload } from '../model/editor-draft';
import { normalizeMessage } from './message-normalizer';

test('keeps native instructions out of user message display and editor drafts', () => {
  const text =
    'Review this project' + '\n\n' + buildSwarmWorkflowInstruction({ mode: 'review', verify: true });
  expect(stripSwarmWorkflowInstruction(text)).toBe('Review this project');
  expect(parseEditorDraftPayload(text, []).text).toBe('Review this project');
  expect(normalizeMessage({ role: 'user', content: text }).content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'Review this project' }),
    ]),
  );
});
test('does not hide user-authored tags, similar prose, or embedded snippets', () => {
  const text = 'Explain <parallel-collaboration-request>hello</parallel-collaboration-request>';
  expect(stripSwarmWorkflowInstruction(text)).toBe(text);
  const snippet = buildSwarmWorkflowInstruction({ mode: 'auto', verify: false }) + '\nExplain this';
  expect(stripSwarmWorkflowInstruction(snippet)).toBe(snippet);
});
test('preserves browser annotation transport when removing the exact Swarm suffix', () => {
  const browser = composeBrowserGatewayPrompt('Review page', []);
  expect(
    stripSwarmWorkflowInstruction(
      browser + '\n\n' + buildSwarmWorkflowInstruction({ mode: 'research', verify: false }),
    ),
  ).toBe(browser);
});
