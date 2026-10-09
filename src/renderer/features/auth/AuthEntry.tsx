/// <reference lib="es2022.intl" />

import { UserIcon } from '@heroicons/react/24/outline';
import { AuthErrorCode, AuthOperation, AuthStatus, AuthSyncStatus } from '@shared/app/auth';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import { useAuth } from './useAuth';

const accountNameSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ERROR_KEYS: Record<AuthErrorCode, string> = {
  [AuthErrorCode.SdkUnavailable]: 'authSdkUnavailable',
  [AuthErrorCode.LoginFailed]: 'authLoginFailed',
  [AuthErrorCode.StorageFailed]: 'authStorageFailed',
  [AuthErrorCode.SyncFailed]: 'authSyncFailed',
  [AuthErrorCode.LogoutFailed]: 'authLogoutFailed',
  [AuthErrorCode.SessionChanged]: 'authSessionChanged',
  [AuthErrorCode.Unavailable]: 'authUnavailable',
};

export default function AuthEntry({ compact = false }: { compact?: boolean }) {
  const { state, loading, errorCode, login, logout, retrySync } = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const busy = loading || state.operation !== AuthOperation.Idle;
  const hasAccount = state.status !== AuthStatus.SignedOut;
  const accountName = state.profile?.displayName.trim() || state.profile?.account.trim() || '';
  const label = accountName || i18nService.t('authLogin');
  const initial = accountNameSegmenter.segment(accountName)[Symbol.iterator]().next()
    .value?.segment;
  const subtitle =
    state.operation === AuthOperation.Login
      ? 'authSigningIn'
      : state.operation === AuthOperation.Logout
        ? 'authSigningOut'
        : state.syncStatus === AuthSyncStatus.Pending
          ? 'authSyncPending'
          : state.status === AuthStatus.LocalCredentials
            ? 'authLocalCredentials'
            : 'authSignedIn';

  useEffect(() => {
    if (!open) return;
    const clickOutside = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !menu.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', clickOutside);
    document.addEventListener('keydown', keydown);
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      document.removeEventListener('mousedown', clickOutside);
      document.removeEventListener('keydown', keydown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !compact) return;
    const updatePosition = () => {
      const avatar = button.current?.getBoundingClientRect();
      if (!avatar) return;
      const menuWidth = menu.current?.offsetWidth || 208;
      const menuHeight = menu.current?.offsetHeight || 128;
      setMenuPosition({
        left: Math.max(8, Math.min(avatar.right + 10, window.innerWidth - menuWidth - 8)),
        top: Math.max(8, Math.min(avatar.bottom - menuHeight, window.innerHeight - menuHeight - 8)),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, compact, busy, errorCode, hasAccount, state.syncStatus]);

  const startLogin = async () => {
    setOpen(false);
    const result = await login();
    if (result && !result.success && root.current) setOpen(true);
  };

  const panel = open ? (
    <div
      id={menuId}
      ref={menu}
      role="region"
      aria-label={i18nService.t('authAccountMenu')}
      className={`non-draggable z-[60] w-max min-w-52 max-w-[calc(100vw-1rem)] rounded-xl border border-border-subtle bg-surface p-2 shadow-lg ${compact ? 'fixed' : 'absolute bottom-full left-0 mb-2'}`}
      style={compact ? menuPosition : undefined}
    >
      {state.profile && (
        <div className="border-b border-border-subtle px-2 pb-2 mb-1">
          <p className="truncate text-sm font-medium text-foreground">
            {state.profile.displayName}
          </p>
          <p className="truncate text-xs text-secondary">{state.profile.account}</p>
        </div>
      )}
      {busy && (
        <p
          role="status"
          className="overflow-x-auto whitespace-nowrap px-2 py-2 text-xs text-secondary"
        >
          {i18nService.t(subtitle)}
        </p>
      )}
      {errorCode && (
        <p
          role="alert"
          className="overflow-x-auto whitespace-nowrap px-2 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {i18nService.t(ERROR_KEYS[errorCode])}
        </p>
      )}
      {state.syncStatus === AuthSyncStatus.Failed && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void retrySync()}
          className="w-full rounded-lg px-2 py-2 text-left text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          {i18nService.t('authRetrySync')}
        </button>
      )}
      {state.status !== AuthStatus.SignedIn && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void startLogin()}
          className="w-full rounded-lg px-2 py-2 text-left text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          {i18nService.t('authLogin')}
        </button>
      )}
      {hasAccount && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void logout()}
          className="w-full rounded-lg px-2 py-2 text-left text-sm text-secondary hover:bg-surface-raised disabled:opacity-50"
        >
          {i18nService.t('authLogout')}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div ref={root} className={`non-draggable relative min-w-0 ${compact ? 'shrink-0' : 'flex-1'}`}>
      <button
        ref={button}
        type="button"
        className={`flex min-w-0 items-center text-secondary transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 ${compact ? 'h-9 w-9 justify-center rounded-xl' : 'w-full gap-2 rounded-lg px-2 py-2 text-left'}`}
        disabled={busy}
        aria-label={hasAccount ? i18nService.t('authAccountMenu') : i18nService.t('authLogin')}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={hasAccount ? `${label} · ${i18nService.t(subtitle)}` : label}
        onClick={hasAccount ? () => setOpen(value => !value) : () => void startLogin()}
      >
        {hasAccount && initial ? (
          <span
            aria-hidden="true"
            className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-surface font-medium leading-none text-foreground ${compact ? 'h-6 w-6 text-xs' : 'h-7 w-7 text-sm'}`}
          >
            {initial}
          </span>
        ) : (
          <UserIcon aria-hidden="true" className={`${compact ? 'h-5 w-5' : 'h-7 w-7'} shrink-0`} />
        )}
        <span className={compact ? 'sr-only' : 'min-w-0'}>
          <span className="block truncate text-sm font-medium" title={label}>
            {label}
          </span>
          {(hasAccount || busy) && (
            <span className="block truncate text-xs text-secondary">
              {loading ? i18nService.t('authLoading') : i18nService.t(subtitle)}
            </span>
          )}
        </span>
      </button>
      {panel && (compact ? createPortal(panel, document.body) : panel)}
    </div>
  );
}
