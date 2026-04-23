/**
 * DiffView Component
 * Pure React diff visualization - no external dependencies.
 * Works offline without web workers.
 * Supports unified (inline) and split (side-by-side) view modes.
 */

import React, { useState, useMemo } from 'react';

export interface DiffData {
  filePath?: string;
  oldStr: string;
  newStr: string;
}

interface DiffViewProps {
  diffDataList: DiffData[];
}

type ViewMode = 'unified' | 'split';

type DiffLineType = 'added' | 'removed' | 'context' | 'header';

interface DiffLine {
  type: DiffLineType;
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
}

const DiffView: React.FC<DiffViewProps> = ({ diffDataList }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [currentEditIndex, setCurrentEditIndex] = useState(0);
  const [isDarkMode, setIsDarkMode] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );

  // Listen for theme changes
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const currentDiff = diffDataList[currentEditIndex];
  const filePath = currentDiff?.filePath;
  const editCount = diffDataList.length;

  // Compute diff lines using LCS algorithm
  const diffLines = useMemo(() => {
    if (!currentDiff) return [];
    return computeDiff(currentDiff.oldStr, currentDiff.newStr);
  }, [currentDiff]);

  // Stats
  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const line of diffLines) {
      if (line.type === 'added') added++;
      if (line.type === 'removed') removed++;
    }
    return { added, removed };
  }, [diffLines]);

  // Split view pairs
  const splitPairs = useMemo(() => {
    if (viewMode !== 'split') return [];
    return buildSplitPairs(diffLines);
  }, [diffLines, viewMode]);

  if (diffDataList.length === 0) return null;

  const getLineColor = (type: DiffLineType) => {
    if (isDarkMode) {
      switch (type) {
        case 'added':
          return 'bg-green-500/15 text-green-400';
        case 'removed':
          return 'bg-red-500/15 text-red-400';
        default:
          return 'text-zinc-400';
      }
    } else {
      switch (type) {
        case 'added':
          return 'bg-green-100 text-green-700';
        case 'removed':
          return 'bg-red-100 text-red-700';
        default:
          return 'text-gray-500';
      }
    }
  };

  const getGutterColor = (type: DiffLineType) => {
    if (isDarkMode) {
      switch (type) {
        case 'added':
          return 'text-green-500/50';
        case 'removed':
          return 'text-red-500/50';
        default:
          return 'text-zinc-600';
      }
    } else {
      switch (type) {
        case 'added':
          return 'text-green-600';
        case 'removed':
          return 'text-red-600';
        default:
          return 'text-gray-400';
      }
    }
  };

  return (
    <div className="rounded-lg overflow-hidden border dark:border-zinc-700 border-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 dark:bg-zinc-800 bg-gray-50 border-b dark:border-zinc-700 border-gray-200">
        <div className="flex items-center gap-2 min-w-0">
          {filePath && (
            <span className="text-[11px] font-mono dark:text-zinc-400 text-gray-600 truncate">
              {filePath}
            </span>
          )}
          {editCount > 1 && (
            <span className="text-[10px] dark:text-zinc-500 text-gray-400 flex-shrink-0">
              ({currentEditIndex + 1}/{editCount})
            </span>
          )}
          <span className="flex items-center gap-1.5 text-[10px] flex-shrink-0">
            {stats.added > 0 && (
              <span className="text-green-600 dark:text-green-400 font-medium">+{stats.added}</span>
            )}
            {stats.removed > 0 && (
              <span className="text-red-500 dark:text-red-400 font-medium">-{stats.removed}</span>
            )}
          </span>
        </div>
        {/* View mode toggle */}
        <div className="flex items-center gap-0.5 bg-black/5 dark:bg-white/5 rounded-md p-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('split')}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              viewMode === 'split'
                ? 'bg-white dark:bg-zinc-700 shadow-sm dark:text-zinc-100 text-gray-800'
                : 'dark:text-zinc-400 text-gray-500 hover:dark:text-zinc-300 hover:text-gray-700'
            }`}
          >
            Split
          </button>
          <button
            type="button"
            onClick={() => setViewMode('unified')}
            className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
              viewMode === 'unified'
                ? 'bg-white dark:bg-zinc-700 shadow-sm dark:text-zinc-100 text-gray-800'
                : 'dark:text-zinc-400 text-gray-500 hover:dark:text-zinc-300 hover:text-gray-700'
            }`}
          >
            Unified
          </button>
        </div>
      </div>

      {/* Edit navigation for multiple edits */}
      {editCount > 1 && (
        <div className="flex items-center gap-1 px-3 py-1 dark:bg-zinc-850 bg-gray-100 border-b dark:border-zinc-700/50 border-gray-200/50">
          {diffDataList.map((_, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setCurrentEditIndex(idx)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                idx === currentEditIndex
                  ? 'bg-blue-500/20 dark:bg-blue-400/20 text-blue-600 dark:text-blue-400'
                  : 'dark:text-zinc-500 text-gray-400 hover:dark:text-zinc-400 hover:text-gray-600'
              }`}
            >
              Edit #{idx + 1}
            </button>
          ))}
        </div>
      )}

      {/* Diff content */}
      <div className="max-h-[300px] overflow-auto dark:bg-zinc-900 bg-white">
        {viewMode === 'unified' ? (
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {diffLines.map((line, idx) => (
                <tr key={idx} className={getLineColor(line.type)}>
                  <td
                    className={`select-none text-right px-2 py-0.5 w-8 ${getGutterColor(line.type)}`}
                  >
                    {line.oldLineNo ?? ''}
                  </td>
                  <td
                    className={`select-none text-right px-2 py-0.5 w-8 ${getGutterColor(line.type)}`}
                  >
                    {line.newLineNo ?? ''}
                  </td>
                  <td
                    className={`select-none px-1 py-0.5 w-4 text-center ${getLineColor(line.type)}`}
                  >
                    {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                  </td>
                  <td className="px-2 py-0.5 whitespace-pre-wrap break-all">
                    {line.content || ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-xs font-mono border-collapse table-fixed">
            <tbody>
              {splitPairs.map((pair, idx) => (
                <tr key={idx}>
                  <td
                    className={`select-none text-right px-2 py-0.5 w-8 ${getGutterColor(pair.left?.type || 'context')} ${pair.left ? getLineColor(pair.left.type) : ''}`}
                  >
                    {pair.left?.oldLineNo ?? ''}
                  </td>
                  <td
                    className={`px-2 py-0.5 w-1/2 whitespace-pre-wrap break-all border-r dark:border-zinc-700/50 border-gray-200/50 ${pair.left ? getLineColor(pair.left.type) : 'dark:bg-zinc-850 bg-gray-50'}`}
                  >
                    {pair.left?.content || ' '}
                  </td>
                  <td
                    className={`select-none text-right px-2 py-0.5 w-8 ${getGutterColor(pair.right?.type || 'context')} ${pair.right ? getLineColor(pair.right.type) : ''}`}
                  >
                    {pair.right?.newLineNo ?? ''}
                  </td>
                  <td
                    className={`px-2 py-0.5 w-1/2 whitespace-pre-wrap break-all ${pair.right ? getLineColor(pair.right.type) : 'dark:bg-zinc-850 bg-gray-50'}`}
                  >
                    {pair.right?.content || ' '}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

/**
 * Compute diff using LCS (Longest Common Subsequence) algorithm.
 */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // For very large inputs, use greedy diff
  if (oldLines.length * newLines.length > 100_000) {
    return greedyDiff(oldLines, newLines);
  }

  // LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: 'context',
        oldLineNo: i,
        newLineNo: j,
        content: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({
        type: 'added',
        oldLineNo: null,
        newLineNo: j,
        content: newLines[j - 1],
      });
      j--;
    } else {
      result.push({
        type: 'removed',
        oldLineNo: i,
        newLineNo: null,
        content: oldLines[i - 1],
      });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Greedy diff for large inputs.
 */
function greedyDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length && ni < newLines.length) {
    if (oldLines[oi] === newLines[ni]) {
      result.push({
        type: 'context',
        oldLineNo: oi + 1,
        newLineNo: ni + 1,
        content: oldLines[oi],
      });
      oi++;
      ni++;
    } else {
      // Look ahead for matches
      let foundOld = -1;
      let foundNew = -1;
      const lookAhead = Math.min(10, Math.max(oldLines.length - oi, newLines.length - ni));

      for (let d = 1; d <= lookAhead; d++) {
        if (oi + d < oldLines.length && oldLines[oi + d] === newLines[ni]) {
          foundOld = d;
          break;
        }
        if (ni + d < newLines.length && oldLines[oi] === newLines[ni + d]) {
          foundNew = d;
          break;
        }
      }

      if (foundOld >= 0 && (foundNew < 0 || foundOld <= foundNew)) {
        for (let k = 0; k < foundOld; k++) {
          result.push({
            type: 'removed',
            oldLineNo: oi + k + 1,
            newLineNo: null,
            content: oldLines[oi + k],
          });
        }
        oi += foundOld;
      } else if (foundNew >= 0) {
        for (let k = 0; k < foundNew; k++) {
          result.push({
            type: 'added',
            oldLineNo: null,
            newLineNo: ni + k + 1,
            content: newLines[ni + k],
          });
        }
        ni += foundNew;
      } else {
        result.push({
          type: 'removed',
          oldLineNo: oi + 1,
          newLineNo: null,
          content: oldLines[oi],
        });
        result.push({
          type: 'added',
          oldLineNo: null,
          newLineNo: ni + 1,
          content: newLines[ni],
        });
        oi++;
        ni++;
      }
    }
  }

  while (oi < oldLines.length) {
    result.push({
      type: 'removed',
      oldLineNo: oi + 1,
      newLineNo: null,
      content: oldLines[oi],
    });
    oi++;
  }

  while (ni < newLines.length) {
    result.push({
      type: 'added',
      oldLineNo: null,
      newLineNo: ni + 1,
      content: newLines[ni],
    });
    ni++;
  }

  return result;
}

/**
 * Build split view pairs from diff lines.
 */
function buildSplitPairs(
  lines: DiffLine[],
): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const pairs: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === 'context') {
      pairs.push({ left: line, right: line });
      i++;
    } else if (line.type === 'removed') {
      // Collect consecutive removed lines
      const removedBatch: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'removed') {
        removedBatch.push(lines[i]);
        i++;
      }
      // Collect consecutive added lines
      const addedBatch: DiffLine[] = [];
      while (i < lines.length && lines[i].type === 'added') {
        addedBatch.push(lines[i]);
        i++;
      }
      // Pair them up
      const maxLen = Math.max(removedBatch.length, addedBatch.length);
      for (let k = 0; k < maxLen; k++) {
        pairs.push({
          left: k < removedBatch.length ? removedBatch[k] : null,
          right: k < addedBatch.length ? addedBatch[k] : null,
        });
      }
    } else if (line.type === 'added') {
      pairs.push({ left: null, right: line });
      i++;
    } else {
      i++;
    }
  }

  return pairs;
}

// --- Helpers to detect and extract diff data from tool inputs ---

export function extractDiffFromToolInput(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): DiffData[] | null {
  if (!toolName || !toolInput) return null;
  const normalized = toolName.toLowerCase().replace(/[\s_]+/g, '');

  if (normalized === 'edit' || normalized === 'editfile') {
    const filePath = extractString(toolInput, [
      'file_path',
      'path',
      'filePath',
      'target_file',
      'targetFile',
      'file',
    ]);

    // Try old_str/new_str format
    const oldStr = extractString(toolInput, [
      'old_str',
      'old_string',
      'old_text',
      'oldStr',
      'oldText',
      'search',
      'old',
      'before',
      'original',
    ]);
    const newStr = extractString(toolInput, [
      'new_str',
      'new_string',
      'new_text',
      'newStr',
      'newText',
      'replace',
      'new',
      'after',
      'replacement',
    ]);

    if (oldStr !== null && newStr !== null) {
      return [{ filePath: filePath ?? undefined, oldStr, newStr }];
    }

    // Check for edits array
    const edits =
      toolInput.edits ?? toolInput.changes ?? toolInput.operations ?? toolInput.modifications;
    if (Array.isArray(edits)) {
      const diffs: DiffData[] = [];
      for (const edit of edits) {
        if (edit && typeof edit === 'object') {
          const rec = edit as Record<string, unknown>;
          const editOldStr = extractString(rec, [
            'old_str',
            'old_string',
            'old_text',
            'oldStr',
            'oldText',
            'search',
            'old',
            'before',
            'original',
          ]);
          const editNewStr = extractString(rec, [
            'new_str',
            'new_string',
            'new_text',
            'newStr',
            'newText',
            'replace',
            'new',
            'after',
            'replacement',
          ]);
          if (editOldStr !== null && editNewStr !== null) {
            diffs.push({ filePath: filePath ?? undefined, oldStr: editOldStr, newStr: editNewStr });
          }
        }
      }
      return diffs.length > 0 ? diffs : null;
    }
    return null;
  }

  if (normalized === 'multiedit') {
    const filePath = extractString(toolInput, [
      'file_path',
      'path',
      'filePath',
      'target_file',
      'targetFile',
      'file',
    ]);
    const edits =
      toolInput.edits ?? toolInput.changes ?? toolInput.operations ?? toolInput.modifications;
    if (Array.isArray(edits)) {
      const diffs: DiffData[] = [];
      for (const edit of edits) {
        if (edit && typeof edit === 'object') {
          const rec = edit as Record<string, unknown>;
          const oldStr = extractString(rec, [
            'old_str',
            'old_string',
            'old_text',
            'oldStr',
            'oldText',
            'search',
            'old',
            'before',
            'original',
          ]);
          const newStr = extractString(rec, [
            'new_str',
            'new_string',
            'new_text',
            'newStr',
            'newText',
            'replace',
            'new',
            'after',
            'replacement',
          ]);
          if (oldStr !== null && newStr !== null) {
            diffs.push({ filePath: filePath ?? undefined, oldStr, newStr });
          }
        }
      }
      return diffs.length > 0 ? diffs : null;
    }
    return null;
  }

  return null;
}

function extractString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

export default DiffView;
