import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { expect, test } from 'vitest';

import type { CoworkInteractionRequest } from '../../coworkTypes';
import {
  type QuestionQueueContext,
  questionSourceLabel,
  visibleQuestionQueue,
} from './questionQueue';

const question = (
  id: string,
  patch: Partial<CoworkInteractionRequest> = {},
): CoworkInteractionRequest => ({
  requestId: id,
  sessionId: 'source',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolName: 'ask_user_question',
  toolInput: { sessionKey: `native-${id}`, questions: [] },
  origin: {
    sessionKey: `native-${id}`,
    nativeSessionId: `sid-${id}`,
    toolCallId: `call-${id}`,
    createdAt: Number(id),
    available: true,
  },
  ...patch,
});
const context: QuestionQueueContext = {
  currentSessionId: 'source',
  visible: true,
  sourceViewVisible: true,
  presentation: () => undefined,
  isPluginCurrent: () => true,
};

test('uses FIFO across concurrent sources and never relabels standalone Native questions as the current source', () => {
  const one = question('1');
  const two = question('2', { sessionId: '' });
  expect(visibleQuestionQueue([two, one], context).map(item => item.requestId)).toEqual(['1', '2']);
  expect(questionSourceLabel(two)).toBe('native-2');
  expect(
    visibleQuestionQueue([one, two], {
      ...context,
      currentSessionId: 'different',
    }),
  ).toEqual([two]);
});

test('closed or retired owned questions do not downgrade into globally visible unknown questions', () => {
  const owned = question('1', {
    sessionId: '',
    origin: {
      sessionKey: 'native',
      nativeSessionId: 'sid',
      pluginId: 'owner-plugin',
      epoch: 'old',
      available: true,
    },
  });
  expect(visibleQuestionQueue([owned], { ...context, isPluginCurrent: () => false })).toEqual([]);
  expect(
    visibleQuestionQueue([{ ...owned, origin: { ...owned.origin!, available: false } }], context),
  ).toEqual([]);
  expect(visibleQuestionQueue([owned], { ...context, visible: false })).toEqual([]);
});

test('the current plugin controls focused group visibility without claiming Native reply authority', () => {
  const owned = question('1');
  expect(
    visibleQuestionQueue([owned], {
      ...context,
      presentation: () => ({ visible: false }),
    }),
  ).toEqual([]);
  expect(
    visibleQuestionQueue([owned], {
      ...context,
      currentSessionId: 'other',
      sourceViewVisible: false,
      presentation: () => ({ visible: true, label: 'Group member' }),
    }),
  ).toEqual([owned]);
  expect(questionSourceLabel(owned, { visible: true, label: 'Group member' })).toBe('Group member');
});
