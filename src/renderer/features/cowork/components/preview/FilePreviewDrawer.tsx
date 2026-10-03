import 'katex/dist/katex.min.css';
import './FilePreviewDrawer.css';

import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  FolderOpenIcon,
  PencilSquareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { getPreviewableFileExtension } from '@shared/preview/filePreview';
import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import {
  deferFilePreviewGrantRevocation,
  getFilePreviewEditorLanguage,
  hasUnsavedFilePreviewChanges,
  isFilePreviewCleanAfterSave,
  isValidJsonDocument,
  runFilePreviewSingleFlight,
} from '@/features/cowork/components/preview/filePreviewEditor';
import PreviewMarkdown from '@/features/cowork/components/preview/PreviewMarkdown';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';

import { FilePreviewToolbarContext } from './FilePreviewToolbarContext';
import type { ImageFilePreview } from './imageFilePreview';
import ImageFilePreviewPanel from './ImageFilePreviewPanel';

export interface TextFilePreview {
  kind?: 'text';
  content: string;
  editToken: string;
  filePath: string;
  version: string;
}

export type FilePreview = TextFilePreview | ImageFilePreview;

export interface FilePreviewDrawerHandle {
  requestTransition: () => Promise<boolean>;
}

interface FilePreviewDrawerProps {
  preview: FilePreview;
  onClose: () => void;
  isObscured?: boolean;
  embedded?: boolean;
}

type TextPreviewProps = Omit<FilePreviewDrawerProps, 'preview'> & { preview: TextFilePreview };

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
const MARKDOWN_DOCUMENT_PARSE_LIMIT = 140_000;
const FILE_PREVIEW_DARK_THEME = 'justdo-monokai';
const FILE_PREVIEW_LIGHT_THEME = 'justdo-monokai-light';
const FILE_PREVIEW_UNICODE_HIGHLIGHT = {
  allowedLocales: { 'zh-hans': true, 'zh-hant': true },
  invisibleCharacters: true,
} as const;

const configureFilePreviewThemes: BeforeMount = monaco => {
  monaco.editor.defineTheme(FILE_PREVIEW_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'E6EDF3' },
      { token: 'comment', foreground: '8B949E' },
      { token: 'keyword', foreground: 'FF7B72' },
      { token: 'string', foreground: 'A5D6FF' },
      { token: 'number', foreground: '79C0FF' },
      { token: 'type', foreground: 'D2A8FF' },
      { token: 'type.identifier', foreground: 'D2A8FF' },
      { token: 'class', foreground: 'D2A8FF' },
      { token: 'function', foreground: 'D2A8FF' },
      { token: 'variable', foreground: 'FFA657' },
      { token: 'constant', foreground: '79C0FF' },
      { token: 'delimiter', foreground: 'E6EDF3' },
      { token: 'operator', foreground: 'FF7B72' },
      { token: 'tag', foreground: '7EE787' },
      { token: 'attribute.name', foreground: '79C0FF' },
    ],
    colors: {
      'editor.background': '#0D1117',
      'editor.foreground': '#E6EDF3',
      'editorGutter.background': '#0D1117',
      'editorLineNumber.foreground': '#6E7681',
      'editorLineNumber.activeForeground': '#E6EDF3',
      'editor.selectionBackground': '#264F78',
      'editor.inactiveSelectionBackground': '#264F7866',
      'editor.lineHighlightBackground': '#161B22',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#58A6FF',
      'editorIndentGuide.background1': '#21262D',
      'editorIndentGuide.activeBackground1': '#30363D',
      'editorBracketHighlight.foreground1': '#79C0FF',
      'editorBracketHighlight.foreground2': '#D2A8FF',
      'editorBracketHighlight.foreground3': '#FFA657',
      'scrollbarSlider.background': '#FFFFFF18',
      'scrollbarSlider.hoverBackground': '#FFFFFF2A',
      'scrollbarSlider.activeBackground': '#FFFFFF38',
    },
  });
  monaco.editor.defineTheme(FILE_PREVIEW_LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '1F2328' },
      { token: 'comment', foreground: '6E7781' },
      { token: 'keyword', foreground: 'CF222E' },
      { token: 'string', foreground: '0A3069' },
      { token: 'number', foreground: '0550AE' },
      { token: 'type', foreground: '8250DF' },
      { token: 'type.identifier', foreground: '8250DF' },
      { token: 'class', foreground: '8250DF' },
      { token: 'function', foreground: '8250DF' },
      { token: 'variable', foreground: '953800' },
      { token: 'constant', foreground: '0550AE' },
      { token: 'delimiter', foreground: '1F2328' },
      { token: 'operator', foreground: 'CF222E' },
      { token: 'tag', foreground: '116329' },
      { token: 'attribute.name', foreground: '0550AE' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#1F2328',
      'editorGutter.background': '#FFFFFF',
      'editorLineNumber.foreground': '#8C959F',
      'editorLineNumber.activeForeground': '#1F2328',
      'editor.selectionBackground': '#B6D7FF',
      'editor.inactiveSelectionBackground': '#DDF4FF',
      'editor.lineHighlightBackground': '#F6F8FA',
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': '#0969DA',
      'editorIndentGuide.background1': '#D8DEE4',
      'editorIndentGuide.activeBackground1': '#AFB8C1',
      'editorBracketHighlight.foreground1': '#0550AE',
      'editorBracketHighlight.foreground2': '#8250DF',
      'editorBracketHighlight.foreground3': '#953800',
      'scrollbarSlider.background': '#11182716',
      'scrollbarSlider.hoverBackground': '#11182728',
      'scrollbarSlider.activeBackground': '#11182738',
    },
  });
};

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), viewportMax);
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const TextPreviewDrawer = forwardRef<FilePreviewDrawerHandle, TextPreviewProps>(
  ({ preview, onClose, isObscured = false, embedded = false }, ref) => {
    const sharedToolbarTarget = useContext(FilePreviewToolbarContext);
    const toolbarTarget = embedded ? sharedToolbarTarget : null;
    const extension = getPreviewableFileExtension(preview.filePath) ?? '.txt';
    const isMarkdown = extension === '.md' || extension === '.markdown';
    const [drawerWidth, setDrawerWidth] = useState(() => clampDrawerWidth(DRAWER_DEFAULT_WIDTH));
    const [mode, setMode] = useState<PreviewMode>(() => (isMarkdown ? 'preview' : 'edit'));
    const [savedContent, setSavedContent] = useState(preview.content);
    const [draft, setDraft] = useState(preview.content);
    const [isAuthorizing, setIsAuthorizing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isShowingInFolder, setIsShowingInFolder] = useState(false);
    const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
    const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
    const drawerRef = useRef<HTMLElement>(null);
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
    const isJson = extension === '.json';
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
      const previousEditToken = editTokenRef.current;
      setSavedContent(preview.content);
      setDraft(preview.content);
      draftRef.current = preview.content;
      editTokenRef.current = preview.editToken;
      isEditAuthorizedRef.current = false;
      savedContentRef.current = preview.content;
      versionRef.current = preview.version;
      setMode(isMarkdown ? 'preview' : 'edit');
      if (previousEditToken !== preview.editToken) {
        void window.electron.shell
          .revokePreviewFileEdit(previousEditToken)
          .catch((): undefined => undefined);
      }
    }, [isMarkdown, preview.content, preview.editToken, preview.filePath, preview.version]);

    useEffect(() => {
      if (!drawerRef.current) return;
      (drawerRef.current as HTMLElement & { inert: boolean }).inert = isObscured;
    }, [isObscured]);

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

    const showInFolder = useCallback(async (): Promise<void> => {
      try {
        setIsShowingInFolder(true);
        const result = await window.electron.shell.showItemInFolder(preview.filePath);
        if (!result.success) {
          showToast(result.error || i18nService.t('coworkFilePreviewShowInFolderFailed'));
        }
      } catch {
        showToast(i18nService.t('coworkFilePreviewShowInFolderFailed'));
      } finally {
        if (mountedRef.current) setIsShowingInFolder(false);
      }
    }, [preview.filePath]);

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

    useEffect(() => {
      if (!isMarkdown) void requestEditAuthorization();
    }, [isMarkdown, preview.editToken, requestEditAuthorization]);

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

    const discardDraft = useCallback(() => {
      draftRef.current = savedContentRef.current;
      setDraft(savedContentRef.current);
    }, []);

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

    const applyEditorLanguage: OnMount = useCallback(
      (editor, monaco) => {
        const model = editor.getModel();
        if (model && model.getLanguageId() !== editorLanguage) {
          monaco.editor.setModelLanguage(model, editorLanguage);
        }
      },
      [editorLanguage],
    );

    const handleEditorMount: OnMount = useCallback(
      (editor, monaco) => {
        applyEditorLanguage(editor, monaco);
        editor.addAction({
          id: 'file-preview.save',
          label: i18nService.t('save'),
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: () => saveActionRef.current(),
        });
        editor.focus();
      },
      [applyEditorLanguage],
    );

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

    const fileActions = (
      <>
        <div className="file-preview-primary-actions">
          {isMarkdown && (
            <div className="file-preview-mode-switch" role="group">
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={mode === 'preview' ? 'is-active' : ''}
                aria-label={i18nService.t('coworkFilePreviewModePreview')}
                aria-pressed={mode === 'preview'}
                title={i18nService.t('coworkFilePreviewModePreview')}
              >
                <EyeIcon />
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
                aria-label={i18nService.t('coworkFilePreviewModeEdit')}
                aria-pressed={mode === 'edit'}
                title={i18nService.t('coworkFilePreviewModeEdit')}
              >
                {isAuthorizing ? <ArrowPathIcon className="animate-spin" /> : <PencilSquareIcon />}
              </button>
            </div>
          )}

          {isDirty && (
            <>
              <button
                type="button"
                onClick={discardDraft}
                disabled={isSaving}
                className="file-preview-icon-button"
                aria-label={i18nService.t('coworkFilePreviewRevert')}
                title={i18nService.t('coworkFilePreviewRevert')}
              >
                <ArrowUturnLeftIcon />
              </button>
              <button
                type="button"
                onClick={() => void saveDraft()}
                disabled={isSaving}
                className="file-preview-icon-button file-preview-save-icon-button"
                aria-label={i18nService.t('coworkFilePreviewSaveShortcut')}
                title={i18nService.t('coworkFilePreviewSaveShortcut')}
              >
                {isSaving ? <ArrowPathIcon className="animate-spin" /> : <ArrowDownTrayIcon />}
              </button>
            </>
          )}
        </div>
        <div className="file-preview-title-actions">
          <button
            type="button"
            onClick={() => void showInFolder()}
            disabled={isShowingInFolder}
            className="file-preview-icon-button"
            aria-label={i18nService.t('coworkFilePreviewShowInFolder')}
            title={i18nService.t('coworkFilePreviewShowInFolder')}
          >
            {isShowingInFolder ? <ArrowPathIcon className="animate-spin" /> : <FolderOpenIcon />}
          </button>
          {!toolbarTarget && (
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
          )}
        </div>
      </>
    );

    return (
      <>
        {toolbarTarget &&
          !isObscured &&
          createPortal(
            <div className="file-preview-toolbar-actions">
              {isDirty && (
                <span
                  className="file-preview-title-dirty"
                  title={i18nService.t('coworkFilePreviewUnsaved')}
                >
                  <span aria-hidden="true" />
                  {i18nService.t('coworkFilePreviewUnsavedShort')}
                </span>
              )}
              {fileActions}
            </div>,
            toolbarTarget,
          )}
        <aside
          ref={drawerRef}
          className={`file-preview-shell flex max-w-full flex-col overflow-hidden ${
            embedded
              ? 'is-embedded absolute inset-0 min-h-0 min-w-0'
              : 'absolute bottom-3 right-3 top-3 z-[70]'
          } ${isObscured ? 'is-obscured' : ''}`}
          style={embedded ? undefined : { width: drawerWidth }}
          aria-hidden={isObscured || undefined}
        >
          {!embedded && (
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
          )}

          {!toolbarTarget && (
            <header className="file-preview-header">
              <div className="file-preview-titlebar">
                <div className="file-preview-file-icon" aria-hidden="true">
                  <DocumentTextIcon />
                </div>
                <div className="file-preview-title-copy">
                  <div className="file-preview-title-line">
                    <h2 title={fileName}>{fileName}</h2>
                    <span className="file-preview-type-badge">{fileTypeLabel}</span>
                    {isDirty && (
                      <span
                        className="file-preview-title-dirty"
                        title={i18nService.t('coworkFilePreviewUnsaved')}
                      >
                        <span aria-hidden="true" />
                        {i18nService.t('coworkFilePreviewUnsavedShort')}
                      </span>
                    )}
                  </div>
                  {!embedded && <p title={preview.filePath}>{preview.filePath}</p>}
                </div>
                {fileActions}
              </div>
            </header>
          )}

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
                      theme={isDark ? FILE_PREVIEW_DARK_THEME : FILE_PREVIEW_LIGHT_THEME}
                      beforeMount={configureFilePreviewThemes}
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
                        bracketPairColorization: { enabled: true },
                        cursorBlinking: 'smooth',
                        fontFamily:
                          "'SFMono-Regular', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                        fontLigatures: true,
                        fontSize: 14,
                        guides: { bracketPairs: true, indentation: true },
                        lineHeight: 22,
                        minimap: { enabled: false },
                        padding: { top: 18, bottom: 24 },
                        renderLineHighlight: 'all',
                        roundedSelection: true,
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        unicodeHighlight: FILE_PREVIEW_UNICODE_HIGHLIGHT,
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
              <div
                className={`file-preview-preview-scroll ${isPreformatted ? 'is-preformatted' : ''}`}
              >
                <div className={`file-preview-document ${isPreformatted ? 'is-preformatted' : ''}`}>
                  {isPreformatted ? (
                    <div className="file-preview-readonly-editor">
                      <Editor
                        height="100%"
                        path={preview.filePath}
                        language={editorLanguage}
                        theme={isDark ? FILE_PREVIEW_DARK_THEME : FILE_PREVIEW_LIGHT_THEME}
                        beforeMount={configureFilePreviewThemes}
                        value={content}
                        onMount={applyEditorLanguage}
                        loading={
                          <div className="file-preview-editor-loading">
                            <ArrowPathIcon className="animate-spin" />
                            {i18nService.t('loading')}
                          </div>
                        }
                        options={{
                          automaticLayout: true,
                          bracketPairColorization: { enabled: true },
                          domReadOnly: true,
                          fontFamily:
                            "'SFMono-Regular', 'Cascadia Code', 'Fira Code', Consolas, monospace",
                          fontLigatures: true,
                          fontSize: 14,
                          guides: { bracketPairs: true, indentation: true },
                          lineHeight: 22,
                          minimap: { enabled: false },
                          padding: { top: 30, bottom: 48 },
                          readOnly: true,
                          renderLineHighlight: 'none',
                          scrollBeyondLastLine: false,
                          scrollbar: {
                            horizontal: 'visible',
                            horizontalScrollbarSize: 12,
                            vertical: 'visible',
                            verticalScrollbarSize: 12,
                          },
                          smoothScrolling: true,
                          unicodeHighlight: FILE_PREVIEW_UNICODE_HIGHLIGHT,
                          wordWrap: 'off',
                        }}
                      />
                    </div>
                  ) : (
                    <PreviewMarkdown html={markdownHtml} mermaidIdPrefix="file-preview-mermaid" />
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

TextPreviewDrawer.displayName = 'TextPreviewDrawer';

const FilePreviewDrawer = forwardRef<FilePreviewDrawerHandle, FilePreviewDrawerProps>(
  (props, ref) =>
    props.preview.kind === 'image' ? (
      <ImageFilePreviewPanel
        preview={props.preview}
        onClose={props.onClose}
        isObscured={props.isObscured}
        embedded={props.embedded}
      />
    ) : (
      <TextPreviewDrawer {...props} preview={props.preview} ref={ref} />
    ),
);

FilePreviewDrawer.displayName = 'FilePreviewDrawer';

export default FilePreviewDrawer;
