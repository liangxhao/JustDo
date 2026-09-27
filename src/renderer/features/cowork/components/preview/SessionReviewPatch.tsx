import hljs from 'highlight.js/lib/common';
import { useMemo, useState } from 'react';

import { resolveEditDiffLanguage } from '@/libs/openclaw-chat/components/edit-diff-monaco';
import { i18nService } from '@/services/i18n';

import { parseReviewPatch, type ReviewLine, splitReviewLines } from './parseReviewPatch';

export default function SessionReviewPatch({
  patch,
  path,
  split,
  wrap,
}: {
  patch: string;
  path: string;
  split: boolean;
  wrap: boolean;
}) {
  const parsed = useMemo(() => parseReviewPatch(patch), [patch]);
  const gutter = useMemo(() => {
    const lines = parsed.lines.filter(line => line.kind !== 'hunk' && line.kind !== 'note');
    const maxLine = lines.reduce(
      (max, line) => Math.max(max, line.oldLine ?? 0, line.newLine ?? 0),
      0,
    );
    return {
      old: lines.some(line => line.oldLine !== undefined),
      next: lines.some(line => line.newLine !== undefined),
      width: `${Math.max(2, String(maxLine).length) + 1}ch`,
    };
  }, [parsed]);
  const [limit, setLimit] = useState(200);
  const language = resolveEditDiffLanguage(path);
  const visible = parsed.lines.slice(0, limit);
  const highlighted = useMemo(() => {
    const result = new Map<ReviewLine, string>();
    if (hljs.getLanguage(language)) {
      for (const line of parsed.lines.slice(0, limit)) {
        if (line.kind !== 'hunk' && line.kind !== 'note')
          result.set(
            line,
            hljs.highlight(line.text.slice(0, 4000), { language, ignoreIllegals: true }).value,
          );
      }
    }
    return result;
  }, [parsed, limit, language]);
  const header = (line: ReviewLine) => (
    <div className="review-hunk">
      {line.kind === 'hunk' && (line.omitted ?? 0) > 0 && (
        <span>{i18nService.t('reviewOmitted')} · </span>
      )}
      {line.text.slice(0, 4000)}
    </div>
  );
  const cell = (line: ReviewLine | undefined, side?: 'old' | 'new') => {
    const text = line?.text.slice(0, 4000) ?? '';
    const html = line ? (highlighted.get(line) ?? null) : null;
    return (
      <div className={`review-line review-line-${line?.kind ?? 'empty'}`}>
        {side !== 'new' && (side === 'old' || gutter.old) && (
          <span className="review-number" style={{ width: gutter.width }}>
            {line?.oldLine}
          </span>
        )}
        {side !== 'old' && (side === 'new' || gutter.next) && (
          <span className="review-number" style={{ width: gutter.width }}>
            {line?.newLine}
          </span>
        )}
        <span className="review-sign" aria-hidden="true">
          {line?.kind === 'added' ? '+' : line?.kind === 'deleted' ? '−' : ' '}
        </span>
        <code>
          {html === null ? text : <span dangerouslySetInnerHTML={{ __html: html }} />}
          {(line?.text.length ?? 0) > 4000 && <span> … {i18nService.t('reviewLongLine')}</span>}
        </code>
      </div>
    );
  };
  return (
    <div className={`review-patch ${wrap ? 'review-wrap' : ''}`}>
      <div className={split ? 'review-split-grid' : undefined}>
        {split
          ? splitReviewLines(visible).map((row, index) =>
              row.header ? (
                <div className="review-split-header" key={index}>
                  {header(row.header)}
                </div>
              ) : (
                <div className="review-split" key={index}>
                  {cell(row.left, 'old')}
                  {cell(row.right, 'new')}
                </div>
              ),
            )
          : visible.map((line, index) => (
              <div key={index}>
                {line.kind === 'hunk' || line.kind === 'note' ? header(line) : cell(line)}
              </div>
            ))}
      </div>
      {limit < parsed.lines.length && (
        <button className="review-button" onClick={() => setLimit(value => value + 200)}>
          {i18nService.t('reviewMoreLines')}
        </button>
      )}
      {parsed.truncated && <p>{i18nService.t('reviewRenderLimit')}</p>}
      {!parsed.lines.length && <p>{i18nService.t('reviewNoPatch')}</p>}
    </div>
  );
}
