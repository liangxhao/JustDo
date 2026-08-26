import { describe, expect, test } from 'vitest';

import {
  buildEditDiffHunk,
  buildEditDiffView,
  buildEditSplitDiffRows,
  parseEditToolDiff,
} from './edit-tool-diff';

describe('edit tool diff', () => {
  test('parses the current OpenClaw multi-edit input', () => {
    expect(
      parseEditToolDiff('Edit', {
        path: 'src/app.ts',
        edits: [
          { oldText: 'const oldValue = 1;', newText: 'const newValue = 2;' },
          { oldText: 'run(oldValue);', newText: 'run(newValue);' },
        ],
      }),
    ).toEqual({
      path: 'src/app.ts',
      edits: [
        { oldText: 'const oldValue = 1;', newText: 'const newValue = 2;' },
        { oldText: 'run(oldValue);', newText: 'run(newValue);' },
      ],
    });
  });

  test('supports legacy snake-case input and JSON-encoded edits', () => {
    expect(
      parseEditToolDiff('edit_file', {
        file_path: 'src/legacy.ts',
        old_string: 'before',
        new_string: 'after',
      }),
    ).toEqual({
      path: 'src/legacy.ts',
      edits: [{ oldText: 'before', newText: 'after' }],
    });
    expect(
      parseEditToolDiff('MultiEdit', {
        path: 'src/multi.ts',
        edits: JSON.stringify([{ oldText: 'one', newText: 'two' }]),
      }),
    ).toEqual({
      path: 'src/multi.ts',
      edits: [{ oldText: 'one', newText: 'two' }],
    });
  });

  test('preserves a top-level legacy replacement alongside edits', () => {
    expect(
      parseEditToolDiff('edit', {
        path: 'src/mixed.ts',
        edits: [{ oldText: 'one', newText: 'two' }],
        oldText: 'three',
        newText: 'four',
      }),
    ).toEqual({
      path: 'src/mixed.ts',
      edits: [
        { oldText: 'one', newText: 'two' },
        { oldText: 'three', newText: 'four' },
      ],
    });
  });

  test('falls back from Diff rendering when any declared edit is malformed', () => {
    expect(
      parseEditToolDiff('edit', {
        path: 'src/invalid.ts',
        edits: [{ oldText: 'one', newText: 'two' }, { oldText: 'missing replacement' }],
      }),
    ).toBeNull();
    expect(parseEditToolDiff('edit', { path: 'src/invalid.ts', edits: '{bad json' })).toBeNull();
  });

  test('does not treat another tool with replacement-shaped input as Edit', () => {
    expect(
      parseEditToolDiff('exec', {
        path: 'src/app.ts',
        oldText: 'before',
        newText: 'after',
      }),
    ).toBeNull();
  });

  test('builds a line diff while preserving shared context', () => {
    const hunk = buildEditDiffHunk({
      oldText: 'shared\nbefore\ntail',
      newText: 'shared\nafter\ntail',
    });

    expect(hunk).toEqual({
      lines: [
        { kind: 'context', text: 'shared' },
        { kind: 'removed', text: 'before' },
        { kind: 'added', text: 'after' },
        { kind: 'context', text: 'tail' },
      ],
      addedCount: 1,
      removedCount: 1,
      truncated: false,
    });
  });

  test('bounds pathological diffs before they reach the DOM', () => {
    const oldText = Array.from({ length: 700 }, (_, index) => `old ${index}`).join('\n');
    const newText = Array.from({ length: 700 }, (_, index) => `new ${index}`).join('\n');
    const hunk = buildEditDiffHunk({ oldText, newText });

    expect(hunk.truncated).toBe(true);
    expect(hunk.lines).toHaveLength(600);
    expect(hunk.lines.filter(line => line.kind === 'omitted')).toHaveLength(1);
    expect(hunk.addedCount).toBe(700);
    expect(hunk.removedCount).toBe(700);
  });

  test('keeps an isolated middle change visible when collapsing a large context', () => {
    const oldLines = Array.from({ length: 1_000 }, (_, index) => `line ${index + 1}`);
    const newLines = [...oldLines];
    newLines[700] = 'changed line 701';
    const hunk = buildEditDiffHunk({
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
    });

    expect(hunk.truncated).toBe(true);
    expect(hunk.lines).toContainEqual({ kind: 'removed', text: 'line 701' });
    expect(hunk.lines).toContainEqual({ kind: 'added', text: 'changed line 701' });
    expect(hunk.lines.length).toBeLessThan(20);
  });

  test('caps the total rendered rows and hunks for a multi-edit call', () => {
    const view = buildEditDiffView({
      path: 'src/many-edits.ts',
      edits: Array.from({ length: 100 }, (_, index) => ({
        oldText: `old ${index}`,
        newText: `new ${index}`,
      })),
    });

    expect(view.hunks).toHaveLength(40);
    expect(view.omittedEditCount).toBe(60);
    expect(view.hunks.reduce((count, hunk) => count + hunk.lines.length, 0)).toBeLessThanOrEqual(
      600,
    );
    expect(view.hunks[0]?.editIndex).toBe(0);
    expect(view.hunks[view.hunks.length - 1]?.editIndex).toBe(99);
    expect(view.addedCount).toBe(100);
    expect(view.removedCount).toBe(100);
  });

  test('aligns removed and added blocks for the split view', () => {
    expect(
      buildEditSplitDiffRows([
        { kind: 'context', text: 'shared' },
        { kind: 'removed', text: 'old one' },
        { kind: 'removed', text: 'old two' },
        { kind: 'added', text: 'new one' },
        { kind: 'context', text: 'tail' },
      ]),
    ).toEqual([
      {
        before: { kind: 'context', text: 'shared' },
        after: { kind: 'context', text: 'shared' },
      },
      {
        before: { kind: 'removed', text: 'old one' },
        after: { kind: 'added', text: 'new one' },
      },
      { before: { kind: 'removed', text: 'old two' }, after: null },
      {
        before: { kind: 'context', text: 'tail' },
        after: { kind: 'context', text: 'tail' },
      },
    ]);
  });
});
