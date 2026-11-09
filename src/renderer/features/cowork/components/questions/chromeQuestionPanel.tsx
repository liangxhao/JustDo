import type { AskUserAnswers, AskUserQuestion, AskUserWaitPolicy } from '@shared/cowork/interactions/askUserQuestion';
import { parseAskUserQuestions, parseAskUserWaitPolicy } from '@shared/cowork/interactions/askUserQuestion';
import { CoworkInteractionKind } from '@shared/cowork/interactions/interactions';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { CoworkInteractionResult } from '@/features/cowork/coworkTypes';
import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import CoworkQuestionWizard from './CoworkQuestionWizard';

export interface ChromeQuestion {
  requestId: string;
  questions: AskUserQuestion[];
  waitPolicy: AskUserWaitPolicy;
  expiresAt?: number;
  createdAt?: number;
}

interface QuestionPanelOptions {
  respond(threadId: string, requestId: string, response: {
    behavior: 'submit' | 'cancel';
    answers?: AskUserAnswers;
  }): Promise<unknown>;
  onError?(error: unknown): void;
}

/** Host-built adapter: Chrome renders the same question wizard as desktop. */
export function createQuestionPanel(element: HTMLElement, options: QuestionPanelOptions) {
  const root = createRoot(element);
  let threadId = '';
  let questions: ChromeQuestion[] = [];
  let suspended = false;
  let disposed = false;
  let generation = 0;
  const updateTheme = () => element.classList.toggle('dark',
    element.ownerDocument.documentElement.dataset.theme === 'dark');
  const themeObserver = new MutationObserver(updateTheme);
  themeObserver.observe(element.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  updateTheme();

  const current = (thread: string, request: ChromeQuestion, revision: number) =>
    !disposed && !suspended && threadId === thread && generation === revision &&
    questions.some(question => question.requestId === request.requestId &&
      JSON.stringify(question) === JSON.stringify(request));

  function render() {
    if (disposed) return;
    const thread = threadId;
    const revision = generation;
    const visible = questions.length > 0 && !suspended;
    element.classList.toggle('hidden', !visible);
    element.hidden = !visible;
    element.inert = !visible;
    flushSync(() => root.render(
      <OwnerDocumentContext.Provider value={element.ownerDocument}>
        {questions.map((question, index) => (
          <div key={`${thread}/${question.requestId}`} hidden={index !== 0}>
            <CoworkQuestionWizard
              interaction={{
                sessionId: thread,
                requestId: question.requestId,
                toolName: 'ask_user_question',
                interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
                toolInput: {
                  questions: question.questions,
                  waitPolicy: question.waitPolicy,
                  ...(question.expiresAt !== undefined ? { expiresAt: question.expiresAt } : {}),
                },
              }}
              isActive={visible && index === 0}
              onRespond={async (result: CoworkInteractionResult) => {
                if (!current(thread, question, revision) || index !== 0) return false;
                if (result.behavior !== 'submit' && result.behavior !== 'cancel') return false;
                try {
                  await options.respond(thread, question.requestId, {
                    behavior: result.behavior,
                    ...(result.behavior === 'submit'
                      ? { answers: result.updatedInput?.answers as AskUserAnswers } : {}),
                  });
                  if (disposed || threadId !== thread || generation !== revision) return true;
                  questions = questions.filter(candidate => candidate.requestId !== question.requestId);
                  // The wizard is currently rendering its response; unmount after that callback settles.
                  queueMicrotask(render);
                  return true;
                } catch (error) {
                  if (!disposed && threadId === thread && generation === revision) options.onError?.(error);
                  return false;
                }
              }}
            />
          </div>
        ))}
      </OwnerDocumentContext.Provider>,
    ));
  }

  function clear() {
    if (disposed) return;
    generation += 1;
    threadId = '';
    questions = [];
    render();
  }

  return {
    setQuestions(thread: string, pending: ChromeQuestion[]) {
      if (disposed) return;
      if (thread !== threadId) generation += 1;
      threadId = thread;
      const seen = new Set<string>();
      questions = (Array.isArray(pending) ? pending : []).slice(0, 16).filter(question => {
        if (!question || typeof question.requestId !== 'string' || !question.requestId ||
          question.requestId.length > 256 || seen.has(question.requestId)) return false;
        const parsed = parseAskUserQuestions(question.questions);
        if (!parsed || !parseAskUserWaitPolicy(question.waitPolicy, parsed)) return false;
        if (question.expiresAt !== undefined && !Number.isFinite(question.expiresAt)) return false;
        seen.add(question.requestId);
        return true;
      });
      render();
    },
    setSuspended(value: boolean) {
      if (disposed || suspended === value) return;
      suspended = value;
      render();
    },
    get hasPending() { return questions.length > 0; },
    clear,
    dispose() {
      if (disposed) return;
      clear();
      disposed = true;
      themeObserver.disconnect();
      root.unmount();
    },
  };
}
