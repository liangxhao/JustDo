import { expect, test } from 'vitest';

import type { QuestionResult } from '../../../plugins/extensions/ask-user-question/contracts/result';
import { PermissionMode } from '../../shared/security/approvals';
import { toAppServerThread } from './chromeAppServerProjection';
import type { ChromeExtensionMessage } from './chromeAppServerTypes';

test('forwards native footer metadata without inventing a turn outcome or model selection', () => {
  const display = { timestampMs: 1794306645000, modelName: 'internal/actual-model' };
  const projected = toAppServerThread({
    id: 'one', title: 'Answer', status: 'idle', createdAt: 1, updatedAt: 1, cwd: '',
    modelRef: 'internal/selected-model', permissionMode: PermissionMode.Ask,
  }, [{ role: 'assistant', text: 'Answer', display }]);
  expect(projected).toMatchObject({ turns: [], chrome: { display: { turns: [{ items: [{ type: 'agentMessage', display }] }] } } });
  const turn = (projected.chrome as { display: { turns: Array<Record<string, unknown>> } }).display.turns[0];
  expect(turn).not.toHaveProperty('status');
  expect(turn).not.toHaveProperty('completedAt');
  expect(turn).not.toHaveProperty('durationMs');
});

test('retains structured question results for paired and result-only side chat history', () => {
  const questionResult: QuestionResult = {
    version: 1,
    questions: [{ id: 'stack', question: 'Which stack?', options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }] }],
    response: { status: 'answered', answers: { stack: { selected: ['react'] } } },
  };
  const call: ChromeExtensionMessage = { role: 'tool_use', text: '', toolUseId: 'call-1', toolName: 'ask_user_question', toolInput: { questions: questionResult.questions } };
  const result: ChromeExtensionMessage = { role: 'tool_result', text: 'User selected: React', toolUseId: 'call-1', toolName: 'ask_user_question', questionResult };
  for (const messages of [[call, result], [result]]) {
    const projected = toAppServerThread({ id: 'one', title: 'Question', status: 'idle', createdAt: 1, updatedAt: 1, cwd: '', permissionMode: PermissionMode.Full }, messages);
    expect(projected).toMatchObject({ turns: [], chrome: { display: { turns: [{ items: [{ type: 'toolCall', status: 'completed', questionResult }] }] } } });
    const display = (projected.chrome as { display: { turns: Array<Record<string, unknown>> } }).display;
    expect(display.turns[0]).not.toHaveProperty('status');
    expect(display.turns[0]).not.toHaveProperty('completedAt');
  }
});
