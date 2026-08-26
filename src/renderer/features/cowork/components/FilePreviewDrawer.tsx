import 'katex/dist/katex.min.css';
import './FilePreviewDrawer.css';

import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  PencilSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import { getPreviewableFileExtension } from '@shared/filePreview';
import mermaid from 'mermaid';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  deferFilePreviewGrantRevocation,
  getFilePreviewEditorLanguage,
  hasUnsavedFilePreviewChanges,
  isFilePreviewCleanAfterSave,
  isValidJsonDocument,
  runFilePreviewSingleFlight,
} from '@/features/cowork/components/filePreviewEditor';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { renderMermaidSvg } from '@/libs/openclaw-chat/components/mermaidRenderer';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

export interface FilePreview {
  content: string;
  editToken: string;
  filePath: string;
  version: string;
}

export interface FilePreviewDrawerHandle {
  requestTransition: () => Promise<boolean>;
}

interface FilePreviewDrawerProps {
  preview: FilePreview;
  onClose: () => void;
}

type PreviewMode = 'preview' | 'edit';
type ConfirmationKind = 'unsaved' | 'invalid-json';
type ConfirmationChoice = 'save' | 'discard' | 'cancel' | 'overwrite';

interface ConfirmationRequest {
  kind: ConfirmationKind;
  resolve: (choice: ConfirmationChoice) => void;
}

const DRAWER_DEFAULT_WIDTH = 820;
const DRAWER_MIN_WIDTH = 420;
const DRAWER_WINDOW_MARGIN = 24;
const MARKDOWN_CONTENT_MAX_WIDTH = 920;
const MARKDOWN_DOCUMENT_PARSE_LIMIT = 140_000;
const COPY_FEEDBACK_DURATION_MS = 1600;
const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0 2 2v7a2 2 0 0 0 2 2h3"/></svg>';
const COPY_DONE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), viewportMax);
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const FilePreviewDrawer = forwardRef<FilePreviewDrawerHandle, FilePreviewDrawerProps>(
  ({ preview, onClose }, ref) => {
    const [drawerWidth, setDrawerWidth] = useState(() => clampDrawerWidth(DRAWER_DEFAULT_WIDTH));
    const [mode, setMode] = useState<PreviewMode>('preview');
    const [savedContent, setSavedContent] = useState(preview.content);
    const [draft, setDraft] = useState(preview.content);
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
    const [highlightedContent, setHighlightedContent] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
    const drawerRef = useRef<HTMLElement>(null);
    const markdownRef = useRef<HTMLElement>(null);
    const mountedRef = useRef(true);
    const cancelDeferredRevokeRef = useRef<(() => void) | null>(null);
    const confirmationRef = useRef<ConfirmationRequest | null>(null);
    const authorizationPromiseRef = useRef<Promise<boolean> | null>(null);
    const draftRef = useRef(preview.content);
    const editTokenRef = useRef(preview.editToken);
    const isEditAuthorizedRef = useRef(false);
    const savedContentRef = useRef(preview.content);
    const versionRef = useRef(preview.version);
    const savePromiseRef = useRef<Promise<boolean> | null>(null);
    const transitionPromiseRef = useRef<Promise<boolean> | null>(null);
    const saveActionRef = useRef<() => void>(() => undefined);
    const fileName = preview.filePath.split(/[\\/]/).pop() || preview.filePath;
    const extension = getPreviewableFileExtension(preview.filePath) ?? '.txt';
    const isJson = extension === '.json';
    const isMarkdown = extension === '.md' || extension === '.markdown';
    const isPreformatted = !isMarkdown;
    const isDirty = hasUnsavedFilePreviewChanges(draft, savedContent);
    const editorLanguage = getFilePreviewEditorLanguage(extension);
    const fileTypeLabel = extension.slice(1).toUpperCase();
    const content = useMemo(() => {
      if (!isJson) return draft;
      try {
        return JSON.stringify(JSON.parse(draft), null, 2);
      } catch {
        return draft;
      }
    }, [draft, isJson]);
    const markdownHtml = useMemo(
      () =>
        isPreformatted
          ? ''
          : toSanitizedMarkdownHtml(content, {
              parseLimit: MARKDOWN_DOCUMENT_PARSE_LIMIT,
              renderFrontmatter: true,
            }),
      [content, isPreformatted],
    );

    useEffect(() => {
      if (!isPreformatted || mode !== 'preview') {
        setHighlightedContent(null);
        return;
      }

      let cancelled = false;
      setHighlightedContent(null);
      void loader
        .init()
        .then(async monaco => {
          monaco.editor.setTheme(isDark ? 'vs-dark' : 'vs');
          const html = await monaco.editor.colorize(content, editorLanguage, { tabSize: 2 });
          if (!cancelled) setHighlightedContent(html);
        })
        .catch(() => {
          if (!cancelled) setHighlightedContent(null);
        });

      return () => {
        cancelled = true;
      };
    }, [content, editorLanguage, isDark, isPreformatted, mode]);

    useEffect(() => {
      const previousEditToken = editTokenRef.current;
      setSavedContent(preview.content);
      setDraft(preview.content);
      draftRef.current = preview.content;
      editTokenRef.current = preview.editToken;
      isEditAuthorizedRef.current = false;
      savedContentRef.current = preview.content;
      versionRef.current = preview.version;
      setMode('preview');
      if (previousEditToken !== preview.editToken) {
        void window.electron.shell
          .revokePreviewFileEdit(previousEditToken)
          .catch((): undefined => undefined);
      }
    }, [preview.content, preview.editToken, preview.filePath, preview.version]);

    useEffect(() => {
      cancelDeferredRevokeRef.current?.();
      cancelDeferredRevokeRef.current = null;
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        confirmationRef.current?.resolve('cancel');
        confirmationRef.current = null;
        const editToken = editTokenRef.current;
        cancelDeferredRevokeRef.current = deferFilePreviewGrantRevocation(
          editToken,
          token => {
            void window.electron.shell
              .revokePreviewFileEdit(token)
              .catch((): undefined => undefined);
          },
          callback => {
            window.setTimeout(callback, 0);
          },
        );
      };
    }, []);

    useEffect(() => {
      const observer = new MutationObserver(() => {
        setIsDark(document.documentElement.classList.contains('dark'));
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    }, []);

    useEffect(() => {
      const root = markdownRef.current;
      if (!root || isPreformatted || mode !== 'preview') return;

      root.querySelectorAll<HTMLElement>('.code-block-copy__idle').forEach(label => {
        label.innerHTML = COPY_ICON;
        label.style.display = 'inline-flex';
      });
      root.querySelectorAll<HTMLElement>('.code-block-copy__done').forEach(label => {
        label.innerHTML = COPY_DONE_ICON;
        label.style.display = 'none';
      });
      root.querySelectorAll<HTMLButtonElement>('.code-block-copy').forEach(button => {
        const label = i18nService.t('copyToClipboard');
        button.setAttribute('aria-label', label);
        button.title = label;
      });

      let cancelled = false;
      const renderDiagrams = async () => {
        const blocks = root.querySelectorAll<HTMLElement>('.mermaid-block');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDark ? 'dark' : 'default',
        });

        for (const block of blocks) {
          const target = block.querySelector<HTMLElement>('.mermaid-preview');
          const source = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
          if (!target || !source) continue;
          try {
            const id = `file-preview-mermaid-${crypto.randomUUID()}`;
            const svg = await renderMermaidSvg(id, source, target);
            if (!cancelled) target.innerHTML = svg;
          } catch (error) {
            if (cancelled) return;
            target.classList.add('mermaid-error');
            target.textContent =
              error instanceof Error ? error.message : i18nService.t('mermaidRenderFailed');
          }
        }
      };

      void renderDiagrams();
      return () => {
        cancelled = true;
      };
    }, [isDark, isPreformatted, markdownHtml, mode]);

    const askForConfirmation = useCallback(
      (kind: ConfirmationKind): Promise<ConfirmationChoice> =>
        new Promise(resolve => {
          const request = { kind, resolve };
          confirmationRef.current = request;
          setConfirmation(request);
        }),
      [],
    );

    const settleConfirmation = useCallback((choice: ConfirmationChoice) => {
      confirmationRef.current?.resolve(choice);
      confirmationRef.current = null;
      setConfirmation(null);
    }, []);

    const reloadFromDisk = useCallback(async (): Promise<boolean> => {
      try {
        const result = await window.electron.shell.readPreviewFile(preview.filePath);
        if (!result.success) {
          showToast(
            result.tooLarge
              ? i18nService.t('coworkFilePreviewTooLarge')
              : result.error || i18nService.t('coworkFilePreviewReloadFailed'),
          );
          return false;
        }
        if (!mountedRef.current) return false;
        setSavedContent(result.content);
        setDraft(result.content);
        draftRef.current = result.content;
        const previousEditToken = editTokenRef.current;
        editTokenRef.current = result.editToken;
        isEditAuthorizedRef.current = false;
        savedContentRef.current = result.content;
        versionRef.current = result.version;
        void window.electron.shell
          .revokePreviewFileEdit(previousEditToken)
          .catch((): undefined => undefined);
        showToast(i18nService.t('coworkFilePreviewReloaded'));
        return true;
      } catch {
        showToast(i18nService.t('coworkFilePreviewReloadFailed'));
        return false;
      }
    }, [preview.filePath]);

    const requestEditAuthorization = useCallback((): Promise<boolean> => {
      if (isEditAuthorizedRef.current) return Promise.resolve(true);
      return runFilePreviewSingleFlight(authorizationPromiseRef, async () => {
        try {
          setIsAuthorizing(true);
          const result = await window.electron.shell.authorizePreviewFileEdit({
            editToken: editTokenRef.current,
            expectedVersion: versionRef.current,
          });
          if (result.success) {
            isEditAuthorizedRef.current = true;
            return true;
          }
          if (result.reload) await reloadFromDisk();
          else if (result.error) {
            showToast(
              result.tooLarge
                ? i18nService.t('coworkFilePreviewTooLarge')
                : i18nService.t('coworkFilePreviewAuthorizationFailed'),
            );
          }
          return false;
        } catch {
          showToast(i18nService.t('coworkFilePreviewAuthorizationFailed'));
          return false;
        } finally {
          if (mountedRef.current) setIsAuthorizing(false);
        }
      });
    }, [reloadFromDisk]);

    const performSaveDraft = useCallback(async (): Promise<boolean> => {
      if (!(await requestEditAuthorization())) return false;
      const contentToSave = draftRef.current;
      if (isJson && !isValidJsonDocument(contentToSave)) {
        const invalidChoice = await askForConfirmation('invalid-json');
        if (invalidChoice !== 'overwrite') return false;
      }

      try {
        setIsSaving(true);
        const result = await window.electron.shell.writePreviewFile({
          content: contentToSave,
          editToken: editTokenRef.current,
          expectedVersion: versionRef.current,
        });

        if (result.success) {
          if (!mountedRef.current) return false;
          savedContentRef.current = contentToSave;
          setSavedContent(contentToSave);
          versionRef.current = result.version;
          showToast(i18nService.t('coworkFilePreviewSaved'));
          return draftRef.current === contentToSave;
        }
        if (result.reload) return reloadFromDisk();
        if (result.unauthorized) {
          isEditAuthorizedRef.current = false;
          showToast(i18nService.t('coworkFilePreviewAuthorizationFailed'));
          return false;
        }
        if (result.conflict) return false;
        showToast(
          result.tooLarge
            ? i18nService.t('coworkFilePreviewTooLarge')
            : result.error || i18nService.t('coworkFilePreviewSaveFailed'),
        );
        return false;
      } catch {
        showToast(i18nService.t('coworkFilePreviewSaveFailed'));
        return false;
      } finally {
        if (mountedRef.current) setIsSaving(false);
      }
    }, [askForConfirmation, isJson, reloadFromDisk, requestEditAuthorization]);

    const saveDraft = useCallback((): Promise<boolean> => {
      return runFilePreviewSingleFlight(savePromiseRef, performSaveDraft);
    }, [performSaveDraft]);

    saveActionRef.current = () => {
      void saveDraft();
    };

    const requestTransition = useCallback((): Promise<boolean> => {
      return runFilePreviewSingleFlight(transitionPromiseRef, async () => {
        if (
          await isFilePreviewCleanAfterSave(
            savePromiseRef.current,
            () => draftRef.current,
            () => savedContentRef.current,
          )
        ) {
          return true;
        }
        const choice = await askForConfirmation('unsaved');
        if (choice === 'discard') return true;
        if (choice !== 'save') return false;
        await saveDraft();
        return isFilePreviewCleanAfterSave(
          null,
          () => draftRef.current,
          () => savedContentRef.current,
        );
      });
    }, [askForConfirmation, saveDraft]);

    useImperativeHandle(ref, () => ({ requestTransition }), [requestTransition]);

    const handleEditorMount: OnMount = useCallback((editor, monaco) => {
      editor.addAction({
        id: 'file-preview.save',
        label: i18nService.t('save'),
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => saveActionRef.current(),
      });
      editor.focus();
    }, []);

    const handleMarkdownClick = useCallback(async (event: React.MouseEvent<HTMLElement>) => {
      const copyButton = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '.code-block-copy',
      );
      if (copyButton) {
        const code = copyButton.dataset.code;
        if (code === undefined) return;
        await navigator.clipboard.writeText(code);
        const idleIcon = copyButton.querySelector<HTMLElement>('.code-block-copy__idle');
        const doneIcon = copyButton.querySelector<HTMLElement>('.code-block-copy__done');
        if (idleIcon) idleIcon.style.display = 'none';
        if (doneIcon) doneIcon.style.display = 'inline-flex';
        window.setTimeout(() => {
          if (idleIcon) idleIcon.style.display = 'inline-flex';
          if (doneIcon) doneIcon.style.display = 'none';
        }, COPY_FEEDBACK_DURATION_MS);
        return;
      }

      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.mermaid-toggle');
      if (!target) return;
      const block = target.closest<HTMLElement>('.mermaid-block');
      if (!block) return;
      const showSource = !block.classList.contains('is-source');
      block.classList.toggle('is-source', showSource);
      const diagram = block.querySelector<HTMLElement>('.mermaid-preview');
      const source = block.querySelector<HTMLElement>('.mermaid-source');
      const label = block.querySelector<HTMLElement>('.code-block-lang');
      if (diagram) diagram.hidden = showSource;
      if (source) source.hidden = !showSource;
      if (label) label.textContent = showSource ? 'mermaid' : 'mermaid (rendered)';
      const buttonLabel = i18nService.t(showSource ? 'renderDiagram' : 'showCode');
      target.setAttribute('aria-label', buttonLabel);
      target.title = buttonLabel;
    }, []);

    useEffect(() => {
      const handleResize = () => setDrawerWidth(width => clampDrawerWidth(width));
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, []);

    const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
      const right = drawerRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      event.preventDefault();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        setDrawerWidth(clampDrawerWidth(right - moveEvent.clientX));
      };
      const handleMouseUp = () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }, []);

    const confirmationCopy = confirmation
      ? {
          unsaved: {
            title: i18nService.t('coworkFilePreviewUnsavedTitle'),
            description: i18nService.t('coworkFilePreviewUnsavedDescription'),
          },
          'invalid-json': {
            title: i18nService.t('coworkFilePreviewInvalidJsonTitle'),
            description: i18nService.t('coworkFilePreviewInvalidJsonDescription'),
          },
        }[confirmation.kind]
      : null;

    return (
      <>
        <aside
          ref={drawerRef}
          className="file-preview-shell absolute bottom-3 right-3 top-3 z-[70] flex max-w-full flex-col overflow-hidden"
          style={{ width: drawerWidth }}
        >
          <div
            className="file-preview-resize-handle"
            onMouseDown={handleResizeStart}
            role="separator"
            aria-orientation="vertical"
            aria-label={i18nService.t('coworkFilePreviewResize')}
            title={i18nService.t('coworkFilePreviewResize')}
          >
            <span />
          </div>

          <header className="file-preview-header">
            <div className="file-preview-titlebar">
              <div className="file-preview-file-icon" aria-hidden="true">
                <DocumentTextIcon />
              </div>
              <div className="file-preview-title-copy">
                <div className="file-preview-title-line">
                  <h2 title={fileName}>{fileName}</h2>
                  <span className="file-preview-type-badge">{fileTypeLabel}</span>
                </div>
                <p title={preview.filePath}>{preview.filePath}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  void requestTransition().then(canClose => {
                    if (canClose) onClose();
                  });
                }}
                disabled={isSaving}
                className="file-preview-icon-button"
                aria-label={i18nService.t('close')}
                title={i18nService.t('close')}
              >
                <XMarkIcon />
              </button>
            </div>

            <div className="file-preview-toolbar">
              <div className="file-preview-mode-switch" role="group">
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={mode === 'preview' ? 'is-active' : ''}
                  aria-pressed={mode === 'preview'}
                >
                  <EyeIcon />
                  {i18nService.t('coworkFilePreviewModePreview')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void requestEditAuthorization().then(authorized => {
                      if (authorized && mountedRef.current) setMode('edit');
                    });
                  }}
                  disabled={isAuthorizing}
                  className={mode === 'edit' ? 'is-active' : ''}
                  aria-pressed={mode === 'edit'}
                >
                  {isAuthorizing ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : (
                    <PencilSquareIcon />
                  )}
                  {i18nService.t('coworkFilePreviewModeEdit')}
                </button>
              </div>

              <div className="file-preview-toolbar-actions">
                {isDirty && (
                  <div
                    className="file-preview-save-status is-dirty"
                    title={i18nService.t('coworkFilePreviewUnsaved')}
                  >
                    <span />
                    {i18nService.t('coworkFilePreviewUnsaved')}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!isDirty || isSaving}
                  className="file-preview-save-button"
                  title={i18nService.t('coworkFilePreviewSaveShortcut')}
                >
                  {isSaving ? <ArrowPathIcon className="animate-spin" /> : <ArrowDownTrayIcon />}
                  {isSaving ? i18nService.t('saving') : i18nService.t('save')}
                </button>
              </div>
            </div>
          </header>

          <div className={`file-preview-workspace ${mode === 'edit' ? 'is-editing' : ''}`}>
            {mode === 'edit' ? (
              <div className="file-preview-editor-stage">
                <div className="file-preview-editor-frame">
                  <div className="file-preview-editor-meta">
                    <span>{fileTypeLabel}</span>
                    <span>{i18nService.t('coworkFilePreviewSaveShortcut')}</span>
                  </div>
                  <div className="file-preview-editor-pane">
                    <Editor
                      height="100%"
                      path={preview.filePath}
                      language={editorLanguage}
                      theme={isDark ? 'vs-dark' : 'vs'}
                      value={draft}
                      onChange={value => {
                        const nextDraft = value ?? '';
                        draftRef.current = nextDraft;
                        setDraft(nextDraft);
                      }}
                      onMount={handleEditorMount}
                      loading={
                        <div className="file-preview-editor-loading">
                          <ArrowPathIcon className="animate-spin" />
                          {i18nService.t('loading')}
                        </div>
                      }
                      options={{
                        automaticLayout: true,
                        cursorBlinking: 'smooth',
                        fontFamily:
                          "'SFMono-Regular', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                        fontLigatures: true,
                        fontSize: 13.5,
                        lineHeight: 22,
                        minimap: { enabled: false },
                        padding: { top: 18, bottom: 24 },
                        renderLineHighlight: 'all',
                        roundedSelection: true,
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        wordWrap:
                          editorLanguage === 'plaintext' || editorLanguage === 'markdown'
                            ? 'on'
                            : 'off',
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="file-preview-preview-scroll">
                <div
                  className={`file-preview-document ${isPreformatted ? 'is-preformatted' : ''}`}
                  style={{ maxWidth: MARKDOWN_CONTENT_MAX_WIDTH }}
                >
                  {isPreformatted ? (
                    <pre
                      className={`file-preview-plain-content monaco-editor ${isDark ? 'vs-dark' : 'vs'}`}
                    >
                      {highlightedContent === null ? (
                        content
                      ) : (
                        <code dangerouslySetInnerHTML={{ __html: highlightedContent }} />
                      )}
                    </pre>
                  ) : (
                    <article
                      ref={markdownRef}
                      className="file-preview-markdown"
                      onClick={handleMarkdownClick}
                      dangerouslySetInnerHTML={{ __html: markdownHtml }}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        {confirmation && confirmationCopy && (
          <Modal
            onClose={() => settleConfirmation('cancel')}
            overlayClassName="file-preview-modal-overlay fixed inset-0 z-[110] flex items-center justify-center p-5"
            className="file-preview-modal w-full max-w-md"
          >
            <div role="dialog" aria-modal="true" aria-labelledby="file-preview-confirm-title">
              <div className="file-preview-modal-heading">
                <div className="file-preview-modal-icon">
                  <ExclamationTriangleIcon />
                </div>
                <div>
                  <h3 id="file-preview-confirm-title">{confirmationCopy.title}</h3>
                  <p>{confirmationCopy.description}</p>
                </div>
              </div>
              <div className="file-preview-modal-actions">
                <button
                  type="button"
                  onClick={() => settleConfirmation('cancel')}
                  className="is-secondary"
                >
                  {i18nService.t('cancel')}
                </button>
                {confirmation.kind === 'unsaved' && (
                  <>
                    <button
                      type="button"
                      onClick={() => settleConfirmation('discard')}
                      className="is-destructive"
                    >
                      {i18nService.t('coworkFilePreviewDiscard')}
                    </button>
                    <button
                      type="button"
                      onClick={() => settleConfirmation('save')}
                      className="is-primary"
                    >
                      {i18nService.t('save')}
                    </button>
                  </>
                )}
                {confirmation.kind === 'invalid-json' && (
                  <button
                    type="button"
                    onClick={() => settleConfirmation('overwrite')}
                    className="is-primary"
                  >
                    {i18nService.t('coworkFilePreviewSaveAnyway')}
                  </button>
                )}
              </div>
            </div>
          </Modal>
        )}
      </>
    );
  },
);

FilePreviewDrawer.displayName = 'FilePreviewDrawer';

export default FilePreviewDrawer;
