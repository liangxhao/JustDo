import React, { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { i18nService } from '@/services/i18n';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

import BrowserContextMenu from './BrowserContextMenu';

type AddressAction = 'cut' | 'copy' | 'paste' | 'paste-and-go' | 'select-all';

type AddressMenu = {
  x: number;
  y: number;
  view: object;
  address: string;
  start: number;
  end: number;
};

export default function BrowserAddressBar({
  inputRef,
  address,
  compactAddress,
  view,
  onEdit,
  onCancel,
  onSubmit,
  onClipboardError,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  address: string;
  compactAddress: string | null;
  view: object;
  onEdit: (value: string) => void;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  onClipboardError: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const [focused, setFocused] = useState(false);
  const [menu, setMenu] = useState<AddressMenu | null>(null);
  const editSequence = useRef(0);
  const activeMenu = menu?.view === view && menu.address === address ? menu : null;
  const showCompact = !focused && !activeMenu && compactAddress !== null;

  useLayoutEffect(() => {
    // Apply the selection once the compact domain has been replaced by the full address.
    if (focused) inputRef.current?.select();
  }, [focused, inputRef]);

  useLayoutEffect(() => {
    editSequence.current++;
    setMenu(null);
  }, [view, address]);

  const openMenu = (input: HTMLInputElement, x: number, y: number) => {
    const editing = ownerDocument.activeElement === input;
    editSequence.current++;
    setMenu({
      x,
      y,
      view,
      address,
      start: editing ? (input.selectionStart ?? 0) : 0,
      end: editing ? (input.selectionEnd ?? address.length) : address.length,
    });
  };

  const dismissMenu = (selection: AddressMenu) => {
    const input = inputRef.current;
    if (!input) return null;
    flushSync(() => {
      setMenu(null);
      input.focus();
    });
    input.setSelectionRange(selection.start, selection.end);
    return input;
  };

  const runAction = async (action: AddressAction, selection: AddressMenu) => {
    const revision = editSequence.current;
    const input = dismissMenu(selection);
    if (!input) return;
    const { start, end } = selection;
    if (action === 'select-all') {
      input.select();
      return;
    }
    const isCurrent = () =>
      revision === editSequence.current &&
      inputRef.current === input &&
      ownerDocument.activeElement === input &&
      input.value === selection.address &&
      input.selectionStart === start &&
      input.selectionEnd === end;
    let replacement = '';
    try {
      if (action === 'copy' || action === 'cut') {
        await ownerWindow.navigator.clipboard.writeText(selection.address.slice(start, end));
      } else {
        replacement = (await ownerWindow.navigator.clipboard.readText()).replace(/[\r\n]/gu, '');
        if (!replacement) return;
      }
    } catch {
      if (isCurrent()) onClipboardError();
      return;
    }
    if (action === 'copy' || !isCurrent()) return;
    if (action === 'paste-and-go') {
      if (replacement.trim()) onSubmit(replacement);
      return;
    }
    flushSync(() => {
      // Use Chromium's editing command so the change emits input and can be undone.
      if (ownerDocument.execCommand?.(replacement ? 'insertText' : 'delete', false, replacement)) {
        return;
      }
      input.value = selection.address.slice(0, start) + replacement + selection.address.slice(end);
      const caret = start + replacement.length;
      input.setSelectionRange(caret, caret);
      onEdit(input.value);
    });
  };

  const hasSelection = !!activeMenu && activeMenu.start !== activeMenu.end;
  return (
    <>
      <input
        ref={inputRef}
        value={showCompact ? compactAddress : address}
        onChange={event => {
          editSequence.current++;
          onEdit(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseDown={event => {
          if (event.button === 2) {
            // Keep an existing selection intact on right-click.
            event.preventDefault();
          } else if (event.button === 0 && event.currentTarget !== ownerDocument.activeElement) {
            event.preventDefault();
            event.currentTarget.focus();
          }
        }}
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.currentTarget, event.clientX, event.clientY);
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            openMenu(event.currentTarget, left, bottom);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            event.currentTarget.blur();
          }
        }}
        className={`h-7 min-w-28 flex-1 rounded-full border border-transparent bg-surface-raised px-3 text-xs text-foreground outline-none transition-colors hover:border-border focus:border-primary ${showCompact ? 'truncate text-center' : 'text-left'}`}
        title={address || undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-label={i18nService.t('browserPanelAddress')}
        placeholder={i18nService.t('browserPanelAddressPlaceholder')}
      />
      {activeMenu && (
        <BrowserContextMenu<AddressAction>
          x={activeMenu.x}
          y={activeMenu.y}
          label={i18nService.t('browserAddressMenuLabel')}
          height={216}
          restoreTriggerFocus={false}
          groups={[
            [
              { action: 'cut', label: i18nService.t('contextMenuCut'), disabled: !hasSelection },
              { action: 'copy', label: i18nService.t('contextMenuCopy'), disabled: !hasSelection },
              { action: 'paste', label: i18nService.t('contextMenuPaste') },
              { action: 'paste-and-go', label: i18nService.t('browserAddressPasteAndGo') },
            ],
            [
              {
                action: 'select-all',
                label: i18nService.t('contextMenuSelectAll'),
                disabled: !address,
              },
            ],
          ]}
          onAction={action => void runAction(action, activeMenu)}
          onDismiss={() => dismissMenu(activeMenu)}
        />
      )}
    </>
  );
}
