import { beforeEach, expect, test as defineTest } from 'vitest';

import {
  buildSwarmWorkflowInstruction,
  stripSwarmWorkflowInstruction,
} from '../../app/contracts/index';
import { presentation } from '../../app/presentation';

const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
const test = hostRoot ? defineTest : defineTest.skip;
const host = (file: string) =>
  hostRoot ? import(/* @vite-ignore */ `${hostRoot}/${file}`) : Promise.resolve({});
const { composeBrowserGatewayPrompt } = await host('src/shared/browser/browser.ts');
const { parseEditorDraftPayload } = await host(
  'src/renderer/libs/openclaw-chat/model/input/editor-draft.ts',
);
const { normalizeMessage } = await host(
  'src/renderer/libs/openclaw-chat/pipeline/message-normalizer.ts',
);
const { registerMessagePresentation } = await host(
  'src/renderer/features/plugins/app/messagePresentation.ts',
);

beforeEach(context => {
  if (hostRoot)
    context.onTestFinished(registerMessagePresentation('plugin-host-projection', presentation));
});

test('keeps native instructions out of user message display and editor drafts', () => {
  const text =
    'Review this project' +
    '\n\n' +
    buildSwarmWorkflowInstruction({ mode: 'review', verify: true });
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
