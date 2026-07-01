import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';

export type ShortcutSettingsValue = {
  newChat: string;
  search: string;
  settings: string;
  sendMessage: string;
};

export const shortcutLabelMap: Record<keyof ShortcutSettingsValue, string> = {
  newChat: 'newChat',
  search: 'search',
  settings: 'openSettings',
  sendMessage: 'sendMessageShortcut',
};

const isSystemShortcut = (e: KeyboardEvent): boolean => {
  const key = e.key.toLowerCase();
  if (e.metaKey && ['c', 'v', 'x', 'z', 'y', 'a', 'q', 'w'].includes(key)) return true;
  if (e.metaKey && e.shiftKey && key === 'z') return true;
  if (e.ctrlKey && ['c', 'v', 'x', 'z', 'y', 'a', 'w'].includes(key)) return true;
  return false;
};

const formatShortcutFromEvent = (e: React.KeyboardEvent): string | null => {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null;
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return null;
  if (isSystemShortcut(e.nativeEvent)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ' ': 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  };
  const key = keyMap[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(key);
  return parts.join('+');
};

const SEND_SHORTCUT_OPTIONS = [
  { value: 'Enter', label: 'Enter', labelMac: 'Enter' },
  { value: 'Ctrl+Enter', label: 'Ctrl+Enter', labelMac: 'Cmd+Enter' },
] as const;

const isMacPlatform = navigator.platform.includes('Mac');

const ShortcutRecorder: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const [recording, setRecording] = useState(false);
  const divRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      onChange('');
      setRecording(false);
      return;
    }
    const shortcut = formatShortcutFromEvent(e);
    if (shortcut) {
      onChange(shortcut);
      setRecording(false);
    }
  };

  useEffect(() => {
    if (!recording) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (divRef.current && !divRef.current.contains(e.target as Node)) setRecording(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [recording]);

  return (
    <div
      ref={divRef}
      tabIndex={0}
      data-shortcut-input="true"
      onKeyDown={handleKeyDown}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
        dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkText text-claude-text
        ${
          recording
            ? 'border-claude-accent ring-1 ring-claude-accent/30 dark:text-claude-darkTextSecondary text-claude-textSecondary'
            : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
        }`}
    >
      {value || i18nService.t('shortcutNotSet')}
    </div>
  );
};

const SendShortcutSelect: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const currentLabel = (() => {
    const opt = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
    if (!opt) return value;
    return isMacPlatform ? opt.labelMac : opt.label;
  })();

  return (
    <div ref={containerRef} className="relative">
      <div
        onClick={() => setOpen(!open)}
        className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
          dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:text-claude-darkText text-claude-text
          ${
            open
              ? 'border-claude-accent ring-1 ring-claude-accent/30'
              : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
          }`}
      >
        {currentLabel}
      </div>
      {open && (
        <div className="absolute right-0 mt-1 z-50 min-w-[160px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset shadow-elevated py-1">
          {SEND_SHORTCUT_OPTIONS.map(option => {
            const label = isMacPlatform ? option.labelMac : option.label;
            const isActive = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex items-center justify-between w-full px-3 py-1.5 text-sm transition-colors
                  ${
                    isActive
                      ? 'dark:text-claude-accent text-claude-accent font-medium'
                      : 'dark:text-claude-darkText text-claude-text'
                  } hover:bg-claude-accent/10`}
              >
                <span>{label}</span>
                {isActive && <span className="text-claude-accent">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

type ShortcutsSettingsProps = {
  shortcuts: ShortcutSettingsValue;
  onShortcutChange: (key: keyof ShortcutSettingsValue, value: string) => void;
};

const ShortcutsSettings: React.FC<ShortcutsSettingsProps> = ({
  shortcuts,
  onShortcutChange,
}) => (
  <div className="space-y-5">
    <div>
      <label className="block text-sm font-medium text-secondary mb-3">
        {i18nService.t('keyboardShortcuts')}
      </label>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('newChat')}</span>
          <ShortcutRecorder
            value={shortcuts.newChat}
            onChange={v => onShortcutChange('newChat', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('search')}</span>
          <ShortcutRecorder
            value={shortcuts.search}
            onChange={v => onShortcutChange('search', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('openSettings')}</span>
          <ShortcutRecorder
            value={shortcuts.settings}
            onChange={v => onShortcutChange('settings', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">
            {i18nService.t('sendMessageShortcut')}
          </span>
          <SendShortcutSelect
            value={shortcuts.sendMessage}
            onChange={v => onShortcutChange('sendMessage', v)}
          />
        </div>
      </div>
    </div>
  </div>
);

export default ShortcutsSettings;
