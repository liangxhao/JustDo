import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Exercise the production callbacks without mounting the full application shell.
// This keeps the composer and widget integration together rather than copying
// their append behavior into a test-only implementation.
function productionExpression(file: string, match: (node: ts.Node) => ts.Expression | undefined) {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.resolve(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    expression ??= match(node);
    if (!expression) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`Production callback missing: ${file}`);
  return ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const widgetDraftExpression = productionExpression('../CoworkView.tsx', node =>
  ts.isJsxAttribute(node) &&
  node.name.getText() === 'onWidgetDraft' &&
  node.initializer &&
  ts.isJsxExpression(node.initializer)
    ? node.initializer.expression
    : undefined,
);
const appendExpression = productionExpression('../composer/CoworkPromptInput.tsx', node =>
  ts.isPropertyAssignment(node) && node.name.getText() === 'appendValue'
    ? node.initializer
    : undefined,
);
const syncDraftExpression = productionExpression('../composer/CoworkPromptInput.tsx', node =>
  ts.isCallExpression(node) &&
  node.expression.getText() === 'useEffect' &&
  node.arguments[0]?.getText().includes('setValue(draftPrompt)')
    ? node.arguments[0]
    : undefined,
);
const focusInputExpression = productionExpression('../composer/CoworkPromptInput.tsx', node =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'handleFocusInput'
    ? node.initializer
    : undefined,
);
const contextMenuExpression = productionExpression('../composer/CoworkPromptInput.tsx', node =>
  ts.isVariableDeclaration(node) &&
  node.name.getText() === 'handleContextMenuAction' &&
  node.initializer &&
  ts.isCallExpression(node.initializer)
    ? node.initializer.arguments[0]
    : undefined,
);

// Use the real state/ref/setter declarations with a React state stub. A raw
// React setter changes rendered state only; it must not silently update a ref.
function composerState(initialValue: string) {
  const file = '../composer/CoworkPromptInput.tsx';
  const source = ts.createSourceFile(
    file,
    readFileSync(path.resolve(__dirname, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const declarations = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      if (ts.isArrayBindingPattern(node.name) && node.name.elements[0]?.getText(source) === 'value')
        declarations.set('state', node);
      else if (['latestValueRef', 'setValue'].includes(node.name.getText(source)))
        declarations.set(node.name.getText(source), node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declarationText = ['state', 'latestValueRef', 'setValue']
    .map(key => declarations.get(key))
    .filter((node): node is ts.VariableDeclaration => !!node)
    .map(node => `const ${node.getText(source)};`)
    .join('\n');
  const visible = { current: initialValue };
  const updateState = vi.fn((value: string) => {
    visible.current = value;
  });
  const result = runInNewContext(
    ts.transpileModule(`${declarationText}\n({ latestValueRef, setValue });`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      draftPrompt: initialValue,
      useState: (value: string) => [value, updateState],
      useRef: (value: string) => ({ current: value }),
      useCallback: (callback: unknown) => callback,
    },
  ) as { latestValueRef: { current: string }; setValue: (value: string) => void };
  return { ...result, setValue: vi.fn(result.setValue), visible };
}

function fixture(
  options: { missingComposer?: boolean; readOnly?: boolean; mutating?: boolean } = {},
) {
  const { latestValueRef, setValue, visible } = composerState('Visible draft with unsaved typing');
  const dispatch = vi.fn();
  const setDraftPrompt = vi.fn((value: { sessionId: string; draft: string }) => value);
  const currentSessionIdRef = { current: 'session-1' };
  const currentGatewaySessionKeyRef = { current: 'native-key-1' };
  const appendValue = runInNewContext(appendExpression, {
    latestValueRef,
    setValue,
    ownerWindow: { requestAnimationFrame: vi.fn() },
  }) as (value: string) => void;
  const callback = runInNewContext(widgetDraftExpression, {
    sessionTranscriptMutation: options.mutating ? { pending: true } : null,
    currentSession: { external: options.readOnly ? { readOnly: true } : undefined },
    store: {
      getState: () => ({
        cowork: {
          currentSession: { id: 'session-1' },
          // Ordinary composer persistence is debounced by 300 ms. Deliberately
          // keep this older than the actual visible input during the add click.
          draftPrompts: { 'session-1': 'Persisted old draft' },
        },
      }),
    },
    currentSessionIdRef,
    currentGatewaySessionKeyRef,
    promptInputRef: {
      current: options.missingComposer ? null : { appendValue, setValue, focus: vi.fn() },
    },
    dispatch,
    setDraftPrompt,
    requestAnimationFrame: vi.fn(),
  }) as ((sessionKey: string, text: string) => void) | undefined;
  return {
    callback,
    latestValueRef,
    visible,
    dispatch,
    setDraftPrompt,
    setValue,
    currentSessionIdRef,
  };
}

describe('native widget draft integration', () => {
  it('appends to the restored current-session draft without carrying text from the previous session', () => {
    const state = fixture();
    runInNewContext(syncDraftExpression, {
      setValue: state.setValue,
      draftPrompt: 'Restored current-session draft',
    })();
    expect(state.visible.current).toBe('Restored current-session draft');

    state.callback!('native-key-1', 'Current-session widget suggestion');

    expect(state.visible.current).toBe(
      'Restored current-session draft\n\nCurrent-session widget suggestion',
    );
    expect(state.latestValueRef.current).toBe(state.visible.current);
  });

  it('does not restore cleared input when a widget suggestion follows the focus-and-clear event', () => {
    const state = fixture();
    runInNewContext(focusInputExpression, {
      setValue: state.setValue,
      dispatch: state.dispatch,
      clearDraftAttachments: vi.fn(),
      draftKey: 'session-1',
      ownerWindow: { requestAnimationFrame: vi.fn() },
    })({ detail: { clear: true } });
    expect(state.visible.current).toBe('');

    state.callback!('native-key-1', 'Widget suggestion');

    expect(state.visible.current).toBe('Widget suggestion');
    expect(state.latestValueRef.current).toBe(state.visible.current);
  });

  it.each(['cut', 'paste'] as const)(
    'preserves the latest context-menu %s before appending a widget suggestion',
    async action => {
      const state = fixture();
      const current = state.visible.current;
      const menu = runInNewContext(contextMenuExpression, {
        value: current,
        latestValueRef: state.latestValueRef,
        setValue: state.setValue,
        textareaRef: {
          current: { selectionStart: 0, selectionEnd: current.length, focus: vi.fn() },
        },
        closeContextMenu: vi.fn(),
        swarmWorkflowOptions: null,
        currentDraftKeyRef: { current: 'session-1' },
        draftKey: 'session-1',
        ownerWindow: {
          navigator: {
            clipboard: {
              readText: vi.fn().mockResolvedValue('Pasted text'),
              writeText: vi.fn().mockResolvedValue(undefined),
            },
          },
          requestAnimationFrame: vi.fn(),
        },
      }) as (action: 'cut' | 'paste') => Promise<void>;
      await menu(action);
      expect(state.visible.current).toBe(action === 'cut' ? '' : 'Pasted text');

      state.callback!('native-key-1', 'Widget suggestion');

      expect(state.visible.current).toBe(
        action === 'cut' ? 'Widget suggestion' : 'Pasted text\n\nWidget suggestion',
      );
      expect(state.latestValueRef.current).toBe(state.visible.current);
    },
  );

  it('preserves visible unsaved typing and consecutive additions before debounced persistence', () => {
    const state = fixture();

    state.callback!('native-key-1', 'First widget suggestion');
    state.callback!('native-key-1', 'Second widget suggestion');

    expect(state.latestValueRef.current).toBe(
      'Visible draft with unsaved typing\n\nFirst widget suggestion\n\nSecond widget suggestion',
    );
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.setValue).toHaveBeenCalledTimes(2);
  });

  it('stores the draft through Redux when the composer has not mounted', () => {
    const state = fixture({ missingComposer: true });

    state.callback!('native-key-1', 'Widget suggestion');

    expect(state.setDraftPrompt).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'session-1',
      draft: 'Persisted old draft\n\nWidget suggestion',
    });
    expect(state.dispatch).toHaveBeenCalledOnce();
    expect(state.setValue).not.toHaveBeenCalled();
  });

  it('keeps stale sessions, commands and oversized or empty suggestions out of the composer', () => {
    const state = fixture();

    state.callback!('another-native-key', 'Wrong session');
    for (const text of ['', '   ', ' /execute', '!execute', 'x'.repeat(4001)])
      state.callback!('native-key-1', text);
    state.currentSessionIdRef.current = 'session-2';
    state.callback!('native-key-1', 'Old mounted session');

    expect(state.latestValueRef.current).toBe('Visible draft with unsaved typing');
    expect(state.setValue).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('does not expose a draft callback for read-only chats or transcript mutations', () => {
    expect(fixture({ readOnly: true }).callback).toBeUndefined();
    expect(fixture({ mutating: true }).callback).toBeUndefined();
  });
});
