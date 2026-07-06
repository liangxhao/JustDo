import 'katex/dist/katex.min.css';

import mermaid from 'mermaid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toSanitizedMarkdownHtml } from '../../libs/openclaw-chat/components/markdown';
import { i18nService } from '../../services/i18n';

export interface FilePreview {
  content: string;
  filePath: string;
}

interface FilePreviewDrawerProps {
  preview: FilePreview;
  onClose: () => void;
}

const DRAWER_DEFAULT_WIDTH = 736;
const DRAWER_MIN_WIDTH = 360;
const DRAWER_MAX_WIDTH = 1200;
const DRAWER_WINDOW_MARGIN = 16;
const MARKDOWN_CONTENT_MAX_WIDTH = 920;
const COPY_FEEDBACK_DURATION_MS = 1600;
const COPY_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
const COPY_DONE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

const clampDrawerWidth = (width: number): number => {
  const viewportMax = Math.max(DRAWER_MIN_WIDTH, window.innerWidth - DRAWER_WINDOW_MARGIN);
  return Math.min(Math.max(width, DRAWER_MIN_WIDTH), Math.min(DRAWER_MAX_WIDTH, viewportMax));
};

const FilePreviewDrawer: React.FC<FilePreviewDrawerProps> = ({ preview, onClose }) => {
  const [drawerWidth, setDrawerWidth] = useState(() => clampDrawerWidth(DRAWER_DEFAULT_WIDTH));
  const drawerRef = useRef<HTMLElement>(null);
  const markdownRef = useRef<HTMLElement>(null);
  const fileName = preview.filePath.split(/[\\/]/).pop() || preview.filePath;
  const isJson = preview.filePath.toLowerCase().endsWith('.json');
  const isPlainText = preview.filePath.toLowerCase().endsWith('.txt');
  const isPreformatted = isJson || isPlainText;
  const content = useMemo(() => {
    if (!isJson) return preview.content;
    try {
      return JSON.stringify(JSON.parse(preview.content), null, 2);
    } catch {
      return preview.content;
    }
  }, [isJson, preview.content]);
  const markdownHtml = useMemo(
    () => (isPreformatted ? '' : toSanitizedMarkdownHtml(content)),
    [content, isPreformatted],
  );

  useEffect(() => {
    const root = markdownRef.current;
    if (!root || isPreformatted) return;

    root.querySelectorAll<HTMLElement>('.code-block-copy__idle').forEach(label => {
      label.innerHTML = COPY_ICON;
      label.style.display = 'inline-flex';
    });
    root.querySelectorAll<HTMLElement>('.code-block-copy__done').forEach(label => {
      label.innerHTML = COPY_DONE_ICON;
      label.style.display = 'none';
    });
    root.querySelectorAll<HTMLButtonElement>('.code-block-copy').forEach(button => {
      const label = i18nService.t('copy');
      button.setAttribute('aria-label', label);
      button.title = label;
    });

    let cancelled = false;
    const renderDiagrams = async () => {
      const blocks = root.querySelectorAll<HTMLElement>('.mermaid-block');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
      });

      for (const block of blocks) {
        const target = block.querySelector<HTMLElement>('.mermaid-preview');
        const source = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
        if (!target || !source) continue;
        try {
          const id = `file-preview-mermaid-${crypto.randomUUID()}`;
          const { svg } = await mermaid.render(id, source.trim());
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
  }, [isPreformatted, markdownHtml]);

  const handleMarkdownClick = useCallback(async (event: React.MouseEvent<HTMLElement>) => {
    const copyButton = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-block-copy');
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

  return (
    <aside
      ref={drawerRef}
      className="absolute bottom-4 right-0 top-2 z-[70] flex max-w-full flex-col overflow-hidden rounded-l-xl border border-r-0 border-border bg-background shadow-2xl"
      style={{ width: drawerWidth }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-primary/20"
        onMouseDown={handleResizeStart}
        role="separator"
        aria-orientation="vertical"
        aria-label={i18nService.t('coworkFilePreviewResize')}
        title={i18nService.t('coworkFilePreviewResize')}
      />
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{fileName}</h2>
          <p className="truncate text-[11px] text-muted" title={preview.filePath}>
            {preview.filePath}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground"
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {isPreformatted ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
            {content}
          </pre>
        ) : (
          <article
            ref={markdownRef}
            className="mx-auto w-full text-[15px] leading-7 text-foreground [&_.code-block-copy]:inline-flex [&_.code-block-copy]:h-7 [&_.code-block-copy]:w-7 [&_.code-block-copy]:cursor-pointer [&_.code-block-copy]:items-center [&_.code-block-copy]:justify-center [&_.code-block-copy]:rounded [&_.code-block-copy]:border [&_.code-block-copy]:border-border [&_.code-block-copy]:text-muted [&_.code-block-copy:hover]:bg-surface-raised [&_.code-block-copy:hover]:text-foreground [&_.code-block-copy_svg]:h-4 [&_.code-block-copy_svg]:w-4 [&_.code-block-copy_svg]:fill-none [&_.code-block-copy_svg]:stroke-current [&_.code-block-copy_svg]:stroke-2 [&_.code-block-copy_svg]:[stroke-linecap:round] [&_.code-block-copy_svg]:[stroke-linejoin:round] [&_.katex-display]:my-6 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.markdown-inline-image]:mx-auto [&_.markdown-inline-image]:my-5 [&_.markdown-inline-image]:max-w-full [&_.mermaid-block]:my-6 [&_.mermaid-block]:overflow-hidden [&_.mermaid-block]:rounded-lg [&_.mermaid-block]:border [&_.mermaid-block]:border-border [&_.mermaid-block]:bg-surface/50 [&_.mermaid-error]:p-4 [&_.mermaid-error]:text-danger [&_.mermaid-preview]:flex [&_.mermaid-preview]:justify-center [&_.mermaid-preview]:overflow-auto [&_.mermaid-preview]:p-5 [&_.mermaid-preview_svg]:h-auto [&_.mermaid-preview_svg]:max-w-full [&_.mermaid-source]:border-t [&_.mermaid-source]:border-border [&_.mermaid-toggle]:rounded [&_.mermaid-toggle]:px-2 [&_.mermaid-toggle]:text-muted [&_.mermaid-toggle:hover]:bg-surface-raised [&_.code-block-header]:flex [&_.code-block-header]:items-center [&_.code-block-header]:justify-between [&_.code-block-header]:border-b [&_.code-block-header]:border-border [&_.code-block-header]:px-3 [&_.code-block-header]:py-1.5 [&_.code-block-lang]:font-mono [&_.code-block-lang]:text-xs [&_.code-block-lang]:text-muted [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-secondary [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_del]:text-muted [&_details]:my-4 [&_h1]:mb-4 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-lg [&_h4]:font-semibold [&_hr]:my-7 [&_hr]:border-border [&_li]:my-1 [&_li]:ml-6 [&_ol]:my-4 [&_ol]:list-decimal [&_p]:my-4 [&_pre]:m-0 [&_pre]:overflow-auto [&_pre]:bg-surface-raised [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-5 [&_table]:w-full [&_table]:border-collapse [&_tbody_tr:nth-child(even)]:bg-surface/60 [&_td]:border [&_td]:border-border [&_td]:p-2.5 [&_th]:border [&_th]:border-border [&_th]:bg-surface-raised [&_th]:p-2.5 [&_th]:font-semibold [&_ul]:my-4 [&_ul]:list-disc"
            style={{ maxWidth: MARKDOWN_CONTENT_MAX_WIDTH }}
            onClick={handleMarkdownClick}
            dangerouslySetInnerHTML={{ __html: markdownHtml }}
          />
        )}
      </div>
    </aside>
  );
};

export default FilePreviewDrawer;
