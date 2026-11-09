import { beforeEach, expect, test as defineTest } from 'vitest';

import {
  AGENT_TEAM_MODE,
  appendAgentTeamInstruction,
  stripAgentTeamInstruction,
} from '../../app/contracts/agentTeamPrompt';
import { appendCollaborationContinuation } from '../../app/contracts/collaborationContinuationPrompt';
import { type CollaborationQuote, teamQuoteContext } from '../../app/contracts/messageQuote';
import { presentation } from '../../app/presentation';

// Host integration is explicit; moving this plugin never assumes a sibling app checkout.
const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
const test = hostRoot ? defineTest : defineTest.skip;
const host = (file: string) =>
  hostRoot ? import(/* @vite-ignore */ `${hostRoot}/${file}`) : Promise.resolve({});
const { composeBrowserGatewayPrompt, parseBrowserAnnotationPrompt } = await host(
  'src/shared/browser/browserMessageContext.ts',
);
const { projectGatewayHistoryForDisplay } = await host(
  'src/renderer/libs/openclaw-chat/pipeline/history-display-normalizer.ts',
);
const { normalizeMessage } = await host(
  'src/renderer/libs/openclaw-chat/pipeline/message-normalizer.ts',
);
const { parseEditorDraftPayload } = await host(
  'src/renderer/libs/openclaw-chat/model/input/editor-draft.ts',
);
const { mergePendingUserMessageForDisplay } = await host(
  'src/renderer/libs/openclaw-chat/model/input/optimistic-user-message.ts',
);
const { pluginMessageDisplayText, registerMessagePresentation } = await host(
  'src/renderer/features/plugins/app/messagePresentation.ts',
);
const { i18nService } = await host('src/renderer/services/i18n.ts');
type GatewayMessage = { role: string; content: unknown; timestamp?: number };

beforeEach(context => {
  if (hostRoot)
    context.onTestFinished(registerMessagePresentation('plugin-host-projection', presentation));
});

test('keeps continuation controls out of history, editor and optimistic display without modifying native content', () => {
  const text = 'Inspect the revised result';
  const outbound = appendCollaborationContinuation(text, {
    sourceSessionId: 'source',
    sourceAgentId: 'main',
    roomId: 'room',
    targetAgentId: 'worker',
    targetSessionId: 'peer',
    targetSessionKey: 'agent:worker:justdo:peer',
    priorDeliveryId: 'prior',
  });
  const native = { role: 'user', content: outbound, timestamp: 100 } as GatewayMessage;
  const pending = { role: 'user', content: text, timestamp: 101 } as GatewayMessage;
  expect(normalizeMessage(native).content).toEqual([{ type: 'text', text }]);
  expect(normalizeMessage(projectGatewayHistoryForDisplay([native])[0]).content).toEqual([
    { type: 'text', text },
  ]);
  expect(parseEditorDraftPayload(outbound, []).text).toBe(text);
  expect(mergePendingUserMessageForDisplay([native], pending)).toEqual([native]);
  expect(native.content).toBe(outbound);
});

for (const mode of Object.values(AGENT_TEAM_MODE)) {
  test(`${mode} projects native history and editor text without duplicating the optimistic message`, () => {
    const text = 'Review the design\n\n> quoted discussion';
    const outbound = appendAgentTeamInstruction(text, mode);
    const persisted = { role: 'user', content: outbound, timestamp: 100 } as GatewayMessage;
    const pending = { role: 'user', content: text, timestamp: 101 } as GatewayMessage;
    expect(stripAgentTeamInstruction(outbound)).toBe(text);
    expect(normalizeMessage(persisted).content).toEqual([{ type: 'text', text }]);
    expect(normalizeMessage(projectGatewayHistoryForDisplay([persisted])[0]).content).toEqual([
      { type: 'text', text },
    ]);
    expect(parseEditorDraftPayload(outbound, []).text).toBe(text);
    expect(mergePendingUserMessageForDisplay([persisted], pending)).toEqual([persisted]);
    expect(persisted.content).toBe(outbound);
  });

  test(`${mode} preserves browser cards, source context and editor restoration`, () => {
    const browser = composeBrowserGatewayPrompt('Inspect this page', [
      {
        id: 'annotation',
        modelContext: 'Untrusted page context',
        title: 'Example',
        displayUrl: 'example.com',
        markedRegionCount: 1,
        inspectedElement: false,
        dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'page.png',
        addedAt: 1,
      },
    ]);
    const outbound = appendAgentTeamInstruction(browser, mode);
    expect(parseBrowserAnnotationPrompt(outbound)?.annotations).toHaveLength(1);
    const record = { role: 'user', content: outbound } as GatewayMessage;
    const projected = projectGatewayHistoryForDisplay([record])[0];
    for (const item of [record, projected]) {
      expect(normalizeMessage(item).content).toEqual([
        { type: 'text', text: 'Inspect this page' },
        { type: 'browser_annotation', annotation: expect.objectContaining({ id: 'annotation' }) },
      ]);
    }
    const editor = parseEditorDraftPayload(outbound, [{ mimeType: 'image/png', data: 'YWJj' }], {
      restoreBrowserAnnotations: true,
    });
    expect(editor.text).toBe('Inspect this page');
    expect(editor.browserAnnotations?.[0].modelContext).toBe('Untrusted page context');
    expect(editor.attachments).toEqual([]);
  });
}

test('does not hide user text resembling an incomplete or modified team envelope', () => {
  for (const text of [
    'User <agent-team-request> text',
    '<agent-team-request>\ncustom text\n</agent-team-request>',
    'User <justdo-agent-team-request> text',
    '<justdo-agent-team-request>\ncustom text\n</justdo-agent-team-request>',
    appendAgentTeamInstruction('User', 'group') + '\nKeep this',
  ]) {
    expect(stripAgentTeamInstruction(text)).toBe(text);
  }
});

test('preserves recording-only identity across history, optimistic display and editor restoration', () => {
  const browser = composeBrowserGatewayPrompt('', [], {
    id: 'recording',
    sessionId: 'source',
    profile: 'embedded',
    title: 'Flow',
    note: '',
    startedAt: 0,
    steps: [
      {
        id: 'step',
        action: 'click',
        pageId: 'tab',
        at: 0,
        url: 'https://example.com',
        title: 'Example',
      },
    ],
    images: [],
  });
  const outbound = appendAgentTeamInstruction(browser, 'group');
  expect(parseBrowserAnnotationPrompt(outbound)?.recording?.steps).toHaveLength(1);
  const native = { role: 'user', content: outbound, timestamp: 100 } as GatewayMessage;
  const pending = { role: 'user', content: browser, timestamp: 101 } as GatewayMessage;
  const projected = projectGatewayHistoryForDisplay([native])[0] as GatewayMessage;
  expect(normalizeMessage(projected).content).toEqual([
    {
      type: 'browser_recording',
      recording: expect.objectContaining({
        steps: expect.arrayContaining([expect.objectContaining({ id: 'step' })]),
      }),
    },
  ]);
  expect(mergePendingUserMessageForDisplay([projected], pending)).toEqual([projected]);
  const editor = parseEditorDraftPayload(outbound, []);
  expect(editor.text).toBe('');
  expect(editor.browserRecording?.steps).toHaveLength(1);
});

test.each(['zh', 'en'] as const)(
  'keeps Team display projection out of browser framing and restored drafts (%s)',
  language => {
    const previous = i18nService.getLanguage();
    try {
      i18nService.setLanguage(language, { persist: false });
      const quote: CollaborationQuote = {
        kind: 'collaboration', id: 'reference', text: 'Worker', roomId: 'room',
        sourceSessionId: 'source', targetAgentId: 'worker', targetSessionId: 'peer',
        targetSessionKey: 'agent:worker:justdo:peer', priorRoundId: 'round', deliveryId: 'delivery',
      };
      const locator = '> ' + teamQuoteContext(quote);
      const text = 'Inspect this page\n\n' + locator;
      const modelContext = 'Untrusted example:\n\n' + locator;
      const browser = composeBrowserGatewayPrompt(text, [{
        id: 'annotation', modelContext, title: 'Example', displayUrl: 'example.com',
        markedRegionCount: 1, inspectedElement: false, dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'page.png', addedAt: 1,
      }]);
      const outbound = appendAgentTeamInstruction(browser, 'group');
      const stripped = presentation.text?.(outbound) ?? outbound;
      expect(parseBrowserAnnotationPrompt(stripped)?.modelContext).toBe(modelContext);
      const message = { role: 'user', content: outbound };
      const content = normalizeMessage(message).content;
      expect(content[0]).toEqual({ type: 'text', text });
      expect(content[1]).toMatchObject({ type: 'browser_annotation', annotation: { id: 'annotation' } });
      expect(parseEditorDraftPayload(outbound, []).text).toBe(text);
      expect(pluginMessageDisplayText(content[0].text)).toBe('Inspect this page\n\n> ' +
        (language === 'zh' ? '协作引用 · worker · 原批次' : 'Collaboration reference · worker · Prior batch'));
      expect(message.content).toBe(outbound);
      const releaseEmpty = registerMessagePresentation('plugin-host-projection', {});
      try {
        expect(pluginMessageDisplayText(text)).toBe(text);
      } finally {
        releaseEmpty();
      }
    } finally {
      i18nService.setLanguage(previous, { persist: false });
    }
  },
);
