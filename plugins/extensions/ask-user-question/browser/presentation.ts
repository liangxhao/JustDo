import { html, nothing, type TemplateResult } from 'lit';

import type { AskUserResponse, Question } from '../contracts/result';

type Translate = (key: string) => string;
type QuestionPresentationResponse =
  AskUserResponse | { status: 'failed' | 'interrupted'; detail?: string };

/** Native cancellation/failure is a presentation outcome, never a synthetic answer. */
export function questionPresentationResponse(
  status: string | undefined,
  response?: AskUserResponse,
  detail?: string,
): QuestionPresentationResponse | undefined {
  if (status === 'completed') return response;
  if (status === 'cancelled') return { status: 'cancelled' };
  if (status === 'failed' || status === 'interrupted')
    return { status, ...(detail ? { detail } : {}) };
  return undefined;
}

function renderAnswer(
  question: Question,
  response: QuestionPresentationResponse,
  t: Translate,
): TemplateResult {
  const answer = response.status === 'answered' ? response.answers[question.id] : undefined;
  return html`
    <div class="question-answer__pair">
      <div class="question-answer__question">${question.question}</div>
      ${
        answer
          ? answer.skipped
            ? html`<div class="question-answer__muted">${t('askUserQuestionSkipped')}</div>`
            : html`
                ${answer.selected.map(id => {
                  const option = question.options.find(item => item.id === id)!;
                  const input = answer.optionInputs?.[id];
                  return html`<div class="question-answer__selection">
                    <div class="question-answer__value">${option.label}</div>
                    ${
                    input
                      ? html`<div class="question-answer__note">
                          ${option.input?.label}: ${input}
                        </div>`
                      : nothing
                  }
                  </div>`;
                })}
                ${
                  answer.other
                    ? html`<div class="question-answer__selection">
                        <div class="question-answer__muted">${t('askUserQuestionOther')}</div>
                        <div class="question-answer__value">${answer.other}</div>
                      </div>`
                    : nothing
                }
              `
          : html`<div class="question-answer__muted">${t('askUserQuestionUnanswered')}</div>`
      }
    </div>
  `;
}

/** Read-only display of a native tool result; collecting answers remains in the host dialog. */
export function renderQuestionPresentation(
  questions: readonly Question[],
  response: QuestionPresentationResponse | undefined,
  t: Translate,
): TemplateResult {
  if (!response) {
    return html`<div class="question-answer__waiting" role="status">
      <span class="question-answer__waiting-marker" aria-hidden="true"></span>
      ${t('askUserQuestionWaiting').replace('{count}', String(questions.length))}
    </div>`;
  }
  const human = response.status === 'answered' && response.timedOut !== true;
  const title = human
    ? 'askUserQuestionYourAnswers'
    : response.status === 'answered'
      ? 'askUserQuestionDefaulted'
      : {
          timeout: 'askUserQuestionTimedOut',
          cancelled: 'askUserQuestionCancelled',
          failed: 'askUserQuestionFailed',
          interrupted: 'askUserQuestionInterrupted',
        }[response.status];
  const detail =
    response.status === 'answered' && response.timedOut === true
      ? 'askUserQuestionAutomatic'
      : response.status === 'timeout'
        ? 'askUserQuestionModelDecides'
        : null;
  return html`<section class=${`question-answer question-answer--${human ? 'human' : 'system'}`}>
    <div class="question-answer__heading">${t(title)}</div>
    ${detail ? html`<div class="question-answer__muted">${t(detail)}</div>` : nothing}
    ${
      (response.status === 'failed' || response.status === 'interrupted') && response.detail
        ? html`<div class="question-answer__failure">${response.detail}</div>`
        : nothing
    }
    <div class="question-answer__body">
      ${renderAnswer(questions[0], response, t)}
      ${
        human && questions.length > 1
          ? html`<details class="question-answer__more">
              <summary>
                <span class="question-answer__more-closed"
                  >${t('askUserQuestionMoreAnswers').replace('{count}', String(questions.length - 1))}</span
                >
                <span class="question-answer__more-open"
                  >${t('askUserQuestionCollapseAnswers')}</span
                >
              </summary>
              ${questions.slice(1).map(question => renderAnswer(question, response, t))}
            </details>`
          : questions.slice(1).map(question => renderAnswer(question, response, t))
      }
    </div>
  </section>`;
}
