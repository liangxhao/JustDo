import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export type ShortcutSettingsValue = {
  newChat: string;
  search: string;
  settings: string;
  sendMessage: string;
  terminal: string;
  browser: string;
  sideChat: string;
  files: string;
};

export const shortcutLabelMap: Record<keyof ShortcutSettingsValue, string> = {
  newChat: 'newChat',
  search: 'search',
  settings: 'openSettings',
  sendMessage: 'sendMessageShortcut',
  terminal: 'shortcutTerminal',
  browser: 'shortcutBrowser',
  sideChat: 'shortcutSideChat',
  files: 'shortcutFiles',
};

export const findShortcutConflict = (
  shortcuts: ShortcutSettingsValue,
  key: keyof ShortcutSettingsValue,
  value: string,
): keyof ShortcutSettingsValue | undefined => {
  if (!value) return undefined;
  return (Object.keys(shortcuts) as (keyof ShortcutSettingsValue)[]).find(
    candidate => candidate !== key && shortcuts[candidate] === value,
  );
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

const ShortcutRecorder: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
}> = ({ label, value, onChange }) => {
  const [recording, setRecording] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) setRecording(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [recording]);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-shortcut-input="true"
      aria-label={`${label}: ${value || i18nService.t('shortcutNotSet')}`}
      aria-pressed={recording}
      onKeyDown={handleKeyDown}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
        bg-surface-raised text-foreground
        ${
          recording
            ? 'border-primary ring-1 ring-primary/30 text-secondary'
            : 'border-border hover:border-primary/50 focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/30'
        }`}
    >
      {value || i18nService.t('shortcutNotSet')}
    </button>
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
      <button
        type="button"
        data-shortcut-input="true"
        aria-label={`${i18nService.t('sendMessageShortcut')}: ${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={event => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`w-36 rounded-xl border px-3 py-1.5 text-sm cursor-pointer select-none text-center outline-none transition-colors
          bg-surface-raised text-foreground
          ${
            open
              ? 'border-primary ring-1 ring-primary/30'
              : 'border-border hover:border-primary/50 focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/30'
          }`}
      >
        {currentLabel}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-50 min-w-[160px] rounded-xl border border-border bg-surface-raised shadow-elevated py-1"
        >
          {SEND_SHORTCUT_OPTIONS.map(option => {
            const label = isMacPlatform ? option.labelMac : option.label;
            const isActive = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex items-center justify-between w-full px-3 py-1.5 text-sm transition-colors
                  ${isActive ? 'text-primary font-medium' : 'text-foreground'} hover:bg-primary/10`}
              >
                <span>{label}</span>
                {isActive && <span className="text-primary">✓</span>}
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

const ShortcutsSettings: React.FC<ShortcutsSettingsProps> = ({ shortcuts, onShortcutChange }) => (
  <div className="space-y-5">
    <div>
      <label className="block text-sm font-medium text-secondary mb-3">
        {i18nService.t('keyboardShortcuts')}
      </label>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('newChat')}</span>
          <ShortcutRecorder
            label={i18nService.t('newChat')}
            value={shortcuts.newChat}
            onChange={v => onShortcutChange('newChat', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('search')}</span>
          <ShortcutRecorder
            label={i18nService.t('search')}
            value={shortcuts.search}
            onChange={v => onShortcutChange('search', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('openSettings')}</span>
          <ShortcutRecorder
            label={i18nService.t('openSettings')}
            value={shortcuts.settings}
            onChange={v => onShortcutChange('settings', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('sendMessageShortcut')}</span>
          <SendShortcutSelect
            value={shortcuts.sendMessage}
            onChange={v => onShortcutChange('sendMessage', v)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('shortcutTerminal')}</span>
          <ShortcutRecorder
            label={i18nService.t('shortcutTerminal')}
            value={shortcuts.terminal}
            onChange={value => onShortcutChange('terminal', value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('shortcutBrowser')}</span>
          <ShortcutRecorder
            label={i18nService.t('shortcutBrowser')}
            value={shortcuts.browser}
            onChange={value => onShortcutChange('browser', value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('shortcutSideChat')}</span>
          <ShortcutRecorder
            label={i18nService.t('shortcutSideChat')}
            value={shortcuts.sideChat}
            onChange={value => onShortcutChange('sideChat', value)}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-foreground">{i18nService.t('shortcutFiles')}</span>
          <ShortcutRecorder
            label={i18nService.t('shortcutFiles')}
            value={shortcuts.files}
            onChange={value => onShortcutChange('files', value)}
          />
        </div>
      </div>
    </div>
  </div>
);

export default ShortcutsSettings;
