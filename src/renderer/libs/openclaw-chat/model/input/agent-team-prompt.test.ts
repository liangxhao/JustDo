import { composeBrowserGatewayPrompt, parseBrowserAnnotationPrompt } from '@shared/browser/browser';
import { expect, test } from 'vitest';

import {
  AGENT_TEAM_MODE,
  appendAgentTeamInstruction,
  stripAgentTeamInstruction,
} from '../../../../../../plugins/extensions/agent-team/app/contracts/agentTeamPrompt';
import { appendCollaborationContinuation } from '../../../../../../plugins/extensions/agent-team/app/contracts/collaborationContinuationPrompt';
import { projectGatewayHistoryForDisplay } from '../../pipeline/history-display-normalizer';
import { normalizeMessage } from '../../pipeline/message-normalizer';
import type { GatewayMessage } from '../../types';
import { parseEditorDraftPayload } from './editor-draft';
import { mergePendingUserMessageForDisplay } from './optimistic-user-message';

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
