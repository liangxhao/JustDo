import { expect, test } from 'vitest';

import type { QuestionResult } from '../../../../plugins/extensions/ask-user-question/contracts/result';
import { PermissionMode } from '../../../shared/security/approvals';
import { toAppServerThread } from './browserAppServerProjection';
import type { BrowserExtensionMessage } from './browserAppServerTypes';

test('retains structured question results for paired and result-only side chat history', () => {
  const questionResult: QuestionResult = {
    version: 1,
    questions: [{ id: 'stack', question: 'Which stack?', options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }] }],
    response: { status: 'answered', answers: { stack: { selected: ['react'] } } },
  };
  const call: BrowserExtensionMessage = { role: 'tool_use', text: '', toolUseId: 'call-1', toolName: 'ask_user_question', toolInput: { questions: questionResult.questions } };
  const result: BrowserExtensionMessage = { role: 'tool_result', text: 'User selected: React', toolUseId: 'call-1', toolName: 'ask_user_question', questionResult };
  for (const messages of [[call, result], [result]]) {
    const projected = toAppServerThread({ id: 'one', title: 'Question', status: 'idle', createdAt: 1, updatedAt: 1, cwd: '', permissionMode: PermissionMode.Full }, messages);
    expect(projected).toMatchObject({ turns: [{ items: [{ type: 'toolCall', status: 'completed', questionResult }] }] });
  }
});
