import {
  ArrowPathIcon,
  ArrowUpRightIcon,
  EyeIcon,
  PaperClipIcon,
  QuestionMarkCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { mcpAppRecord, type NativeAppQuestion } from '@shared/plugins/mcpApps';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { McpAppView, type McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { decodeMcpAppQuestionPreview } from '@/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '@/services/i18n';

import { APP_BUTTON, APP_ICON_BUTTON, APP_INPUT, APP_PRIMARY_BUTTON } from './mcpAppStyles';
import { freeQuestionAnswers, mergeFreeQuestionAnswers } from './questionAnswers';

const t = (key: string) => i18nService.t(key);
function imageSource(value: string | undefined): string | undefined {
  if (!value || value.length > 2 * 1024 * 1024) return;
  if (/^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    /* Native resource thumbnails can require a separate preview. */
  }
}

function QuestionPreview({ value, context }: { value: unknown; context?: McpAppViewContext }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const preview = decodeMcpAppQuestionPreview(value);
    if (!preview || !context || !mount.current) return;
    const view = new McpAppView();
    view.preview = preview;
    view.context = context;
    mount.current.append(view);
    return () => {
      void view.closeApp();
      view.remove();
    };
  }, [value, context]);
  const contents = mcpAppRecord(mcpAppRecord(value)?.preview)?.contents;
  return (
    <div ref={mount}>
      {Array.isArray(contents) &&
        contents.map((item, index) => {
          const content = mcpAppRecord(item);
          if (typeof content?.text === 'string')
            return (
              <pre key={index} className="max-h-64 overflow-auto whitespace-pre-wrap">
                {content.text.slice(0, 64 * 1024)}
              </pre>
            );
          if (
            typeof content?.blob === 'string' &&
            typeof content.mimeType === 'string' &&
            /^image\/(png|jpeg|webp|gif)$/.test(content.mimeType) &&
            /^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)
          )
            return (
              <img
                key={index}
                className="max-h-64 max-w-full"
                alt={typeof content.uri === 'string' ? content.uri : t('mcpAppsPreview')}
                src={`data:${content.mimeType};base64,${content.blob}`}
              />
            );
          return (
            <p key={index}>
              {typeof content?.uri === 'string' ? content.uri : t('mcpAppsPreview')} ·{' '}
              {typeof content?.mimeType === 'string' ? content.mimeType : ''}
            </p>
          );
        })}
    </div>
  );
}

function QuestionForm({
  question,
  sessionId,
  refresh,
  prepare,
}: {
  question: NativeAppQuestion;
  sessionId: string;
  refresh: () => void;
  prepare: () => Promise<McpAppViewContext>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      question.questions.map(field => [field.questionId, field.defaultAnswers ?? []]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ value: unknown; context: McpAppViewContext }>();
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef(false);
  const [uploads, setUploads] = useState<Record<string, string[]>>({});
  const current = useRef(true);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const perform = async (action: () => Promise<void>) => {
    if (pending.current || question.expiresAtMs <= Date.now()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch {
      if (current.current) {
        setError(t('mcpAppsQuestionFailed'));
        refresh();
      }
    } finally {
      pending.current = false;
      if (current.current) setBusy(false);
    }
  };
  const set = (id: string, value: string[]) => {
    setAnswers(previous => ({ ...previous, [id]: value }));
    setError('');
  };
  const expired = question.expiresAtMs <= Date.now();
  return (
    <form
      ref={form}
      className="mt-2 space-y-3 rounded-xl border border-border bg-surface p-3 text-sm"
      aria-busy={busy}
      onSubmit={event => {
        event.preventDefault();
        const submitted = Object.fromEntries(
          question.questions.map(field => {
            const values = answers[field.questionId] ?? [];
            return [
              field.questionId,
              field.allowEmpty && values.length === 1 && values[0] === '' ? [] : values,
            ];
          }),
        );
        const missing = question.questions.find(field => {
          const values = submitted[field.questionId];
          return (
            (!field.allowEmpty && !values.length) ||
            values.some(value =>
              field.isSecret || field.presentation === 'form' ? value.length === 0 : !value.trim(),
            )
          );
        });
        if (missing) {
          setError(t('mcpAppsChooseAnswer'));
          const group = [
            ...(form.current?.querySelectorAll<HTMLElement>('[data-question-field]') ?? []),
          ].find(element => element.dataset.questionField === missing.questionId);
          group?.querySelector<HTMLElement>('input,textarea,button')?.focus();
          return;
        }
        void perform(async () => {
          const result = await window.electron.mcpApps.resolveQuestion({
            sessionId,
            id: question.id,
            answers: submitted,
          });
          if (!result.success) throw new Error(result.error);
          setAnswers({});
          refresh();
        });
      }}
    >
      <div className="flex items-center gap-2 text-xs font-medium text-secondary">
        <QuestionMarkCircleIcon className="h-4 w-4" aria-hidden="true" />
        {t('mcpAppsQuestion')}
        {busy && <ArrowPathIcon className="ml-auto h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
      </div>
      <fieldset disabled={busy || expired} className="space-y-3">
        {question.questions.map(field => (
          <fieldset
            key={field.questionId}
            className="min-w-0 space-y-2"
            data-question-field={field.questionId}
          >
            <legend className="mb-2 block text-sm font-medium text-foreground">
              {field.question || field.header}
            </legend>
            {field.secretStore && (
              <p className="break-words text-xs leading-5 text-secondary">
                {[
                  field.secretStore.reason,
                  field.secretStore.name,
                  field.secretStore.allowedHosts?.join(', '),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
            {field.url && (
              <button
                type="button"
                className={`${APP_BUTTON} max-w-full`}
                onClick={() => {
                  try {
                    const url = new URL(field.url!);
                    if (
                      ['https:', 'http:'].includes(url.protocol) &&
                      !url.username &&
                      !url.password
                    )
                      void window.electron.shell.openExternal(url.href);
                  } catch {
                    /* An invalid native URL is not actionable. */
                  }
                }}
              >
                <span className="truncate">{field.url}</span>
                <ArrowUpRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </button>
            )}
            {field.options.map((option, index) => {
              const value = option.value ?? option.label;
              return (
                <div key={index} className="flex items-center gap-1">
                  <label
                    className={`flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors hover:bg-surface-raised ${(answers[field.questionId] ?? []).includes(value) ? 'border-primary bg-primary-muted' : 'border-border'}`}
                  >
                    <input
                      type={field.multiSelect ? 'checkbox' : 'radio'}
                      name={`${question.id}-${field.questionId}`}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                      checked={(answers[field.questionId] ?? []).includes(value)}
                      onChange={event =>
                        set(
                          field.questionId,
                          field.multiSelect
                            ? event.target.checked
                              ? [...(answers[field.questionId] ?? []), value]
                              : (answers[field.questionId] ?? []).filter(item => item !== value)
                            : [value],
                        )
                      }
                    />
                    {imageSource(option.thumbnail) && (
                      <img
                        src={imageSource(option.thumbnail)}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-12 w-12 rounded object-contain"
                      />
                    )}
                    <span className="min-w-0 break-words text-sm text-foreground">
                      {option.label}
                      {option.description && (
                        <small className="mt-0.5 block text-xs leading-5 text-secondary">
                          {option.description}
                        </small>
                      )}
                    </span>
                  </label>
                  {option.preview && (
                    <button
                      type="button"
                      className={APP_ICON_BUTTON}
                      title={t('mcpAppsPreview')}
                      aria-label={`${t('mcpAppsPreview')}: ${option.label}`}
                      onClick={() =>
                        void perform(async () => {
                          const result = await window.electron.mcpApps.previewQuestion({
                            sessionId,
                            id: question.id,
                            questionId: field.questionId,
                            optionIndex: index,
                          });
                          if (!result.success || !current.current)
                            throw new Error('Preview unavailable');
                          const context = await prepare();
                          if (current.current) setPreview({ value: result.value, context });
                        })
                      }
                    >
                      <EyeIcon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
            {(!field.options.length || field.isOther) &&
              (field.answerFormat === 'lines' && !field.isSecret ? (
                <textarea
                  id={`${question.id}-${field.questionId}`}
                  className={`${APP_INPUT} min-h-20 resize-y`}
                  aria-label={field.question || field.header}
                  value={freeQuestionAnswers(field, answers[field.questionId] ?? []).join('\n')}
                  onChange={event =>
                    set(
                      field.questionId,
                      mergeFreeQuestionAnswers(
                        field,
                        answers[field.questionId] ?? [],
                        event.target.value.split('\n'),
                      ),
                    )
                  }
                  required={!field.allowEmpty && !field.options.length}
                  maxLength={4096}
                />
              ) : (
                <input
                  id={`${question.id}-${field.questionId}`}
                  className={APP_INPUT}
                  aria-label={field.question || field.header}
                  type={field.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  value={freeQuestionAnswers(field, answers[field.questionId] ?? []).join('\n')}
                  onChange={event =>
                    set(
                      field.questionId,
                      mergeFreeQuestionAnswers(field, answers[field.questionId] ?? [], [
                        event.target.value,
                      ]),
                    )
                  }
                  required={!field.allowEmpty && !field.options.length}
                  maxLength={4096}
                />
              ))}
            {field.resource?.userOptions && (
              <button
                type="button"
                className={`${APP_BUTTON} border border-border`}
                onClick={() =>
                  void perform(async () => {
                    const result = await window.electron.mcpApps.uploadQuestion({
                      sessionId,
                      id: question.id,
                      questionId: field.questionId,
                    });
                    if (!result.success || !current.current) throw new Error('Upload unavailable');
                    const resources = mcpAppRecord(result.value)?.resources;
                    if (Array.isArray(resources)) {
                      setUploads(previous => ({
                        ...previous,
                        [field.questionId]: resources.flatMap(item => {
                          const resource = mcpAppRecord(item);
                          return typeof resource?.name === 'string'
                            ? [resource.name]
                            : typeof resource?.uri === 'string'
                              ? [resource.uri.split('/').pop() || resource.uri]
                              : [];
                        }),
                      }));
                      set(
                        field.questionId,
                        resources.flatMap(item => {
                          const resource = mcpAppRecord(item);
                          return typeof resource?.uri === 'string' ? [resource.uri] : [];
                        }),
                      );
                    }
                  })
                }
              >
                <PaperClipIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(
                  field.resource.userOptions.kind === 'directory'
                    ? 'mcpAppsChooseDirectory'
                    : 'mcpAppsChooseFile',
                )}
              </button>
            )}
            {uploads[field.questionId]?.map((name, index) => (
              <span
                className="ml-1 inline-flex max-w-full items-center gap-1 rounded-md bg-surface-raised px-2 py-1 text-xs text-secondary"
                key={index}
              >
                <PaperClipIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate" title={name}>
                  {name}
                </span>
              </span>
            ))}
          </fieldset>
        ))}
      </fieldset>
      <div className="flex items-center justify-end gap-1 border-t border-border pt-2">
        <button
          type="button"
          disabled={busy || expired}
          className={APP_BUTTON}
          onClick={() =>
            void perform(async () => {
              const result = await window.electron.mcpApps.resolveQuestion({
                sessionId,
                id: question.id,
                cancel: true,
              });
              if (!result.success) throw new Error(result.error);
              setAnswers({});
              refresh();
            })
          }
        >
          {t('mcpAppsDecline')}
        </button>
        <button type="submit" disabled={busy || expired} className={APP_PRIMARY_BUTTON}>
          {t('mcpAppsSubmit')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {preview && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between px-2 py-1 text-xs text-secondary">
            <span>{t('mcpAppsPreview')}</span>
            <button
              type="button"
              className={APP_ICON_BUTTON}
              aria-label={t('mcpAppsClose')}
              title={t('mcpAppsClose')}
              onClick={() => setPreview(undefined)}
            >
              <XMarkIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="p-2">
            <QuestionPreview value={preview.value} context={preview.context} />
          </div>
        </div>
      )}
    </form>
  );
}

export function NativeAppQuestions({
  sessionId,
  prepare,
}: {
  sessionId: string;
  prepare: () => Promise<McpAppViewContext>;
}) {
  const [questions, setQuestions] = useState<NativeAppQuestion[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    let readVersion = 0;
    const refresh = async () => {
      const version = ++readVersion;
      try {
        const result = await window.electron.mcpApps.questions(sessionId);
        if (current && version === readVersion && result.success) setQuestions(result.value);
      } catch {
        /* A retired bridge cannot publish an older question snapshot. */
      }
    };
    void refresh();
    const stop = window.electron.mcpApps.onQuestionsChanged(() => void refresh());
    return () => {
      current = false;
      stop();
    };
  }, [sessionId, revision]);
  useEffect(() => {
    if (!questions.length) return;
    const expiresAt = Math.min(...questions.map(question => question.expiresAtMs));
    const timer = window.setTimeout(
      () => setQuestions(items => items.filter(item => item.expiresAtMs > Date.now())),
      Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [questions]);
  return (
    <div className="max-h-[min(440px,55dvh)] space-y-2 overflow-y-auto">
      {questions.map(question => (
        <QuestionForm
          key={`${sessionId}:${question.id}`}
          question={question}
          sessionId={sessionId}
          prepare={prepare}
          refresh={() => setRevision(value => value + 1)}
        />
      ))}
    </div>
  );
}
