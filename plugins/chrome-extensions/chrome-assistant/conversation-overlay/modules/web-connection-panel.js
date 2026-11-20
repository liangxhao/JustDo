import { sidePanelText as t } from './sidepanel-i18n.js';

export const WebConnectionMessage = {
  Decide: 'web-launch:connection:decide',
};
const Status = {
  Waiting: 'waiting-for-window',
  Awaiting: 'awaiting-consent',
  Granting: 'granting',
  Connected: 'connected',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Expired: 'expired',
};
const ACTIVE = new Set([Status.Awaiting, Status.Granting]);
const STATUSES = new Set(Object.values(Status));

/** Presents browser-verified connection consent without claiming or changing a composer. */
export function createWebConnectionPanel({ document, chrome, request, onNotice }) {
  const root = document.getElementById('webConnectionCard');
  if (!root) return { accept() {}, dispose() {} };
  let pending = null;
  let disposed = false;
  let action = 0;
  let allowing = false;
  let denying = false;
  let errorCode = '';
  let expiryTimer;
  const make = (tag, key, parent = root) => {
    const node = document.createElement(tag);
    if (key) node.textContent = t(key);
    parent.append(node);
    return node;
  };
  make('strong', 'webConnectionTitle');
  const origin = make('p');
  origin.className = 'web-launch-origin';
  const hint = make('p', 'webConnectionHint');
  hint.className = 'web-launch-hint';
  const status = make('p');
  status.setAttribute('role', 'status');
  const error = make('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const actions = make('div');
  actions.className = 'web-launch-actions';
  const allow = make('button', 'webConnectionAllow', actions);
  allow.type = 'button';
  allow.className = 'primary';
  const deny = make('button', 'webConnectionDeny', actions);
  deny.type = 'button';
  const active = () => pending && ACTIVE.has(pending.status) && Date.now() < pending.expiresAt;
  const errorText = code => {
    const key = `webConnectionError_${code}`;
    const text = t(key);
    return text === key ? t('webConnectionError_GENERIC') : text;
  };
  const current = (snapshot, operation) =>
    !disposed &&
    action === operation &&
    pending?.pendingId === snapshot.pendingId &&
    pending.revision === snapshot.revision &&
    active();
  function render() {
    const visible = active();
    root.classList.toggle('hidden', !visible);
    if (!visible) return;
    origin.textContent = pending.origin;
    const state = allowing ? Status.Granting : pending.status;
    status.textContent = t(`webConnectionStatus_${state}`);
    allow.disabled =
      pending.status !== Status.Awaiting || allowing || denying || pending.requiresAction === false;
    deny.disabled = denying;
    const code = errorCode || pending.code;
    error.textContent = code ? errorText(code) : '';
    error.hidden = !error.textContent;
  }
  function accept(value) {
    if (disposed) return;
    if (value === null) {
      action += 1;
      pending = null;
      allowing = denying = false;
      clearTimeout(expiryTimer);
      render();
      return;
    }
    if (!value || !STATUSES.has(value.status)) return;
    try {
      const url = new URL(value.origin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== value.origin ||
        typeof value.pendingId !== 'string' ||
        !value.pendingId ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !Number.isFinite(value.expiresAt)
      )
        return;
    } catch {
      return;
    }
    if (
      pending?.pendingId === value.pendingId &&
      (value.revision < pending.revision ||
        (!ACTIVE.has(pending.status) &&
          pending.status !== Status.Waiting &&
          ACTIVE.has(value.status)))
    )
      return;
    const next =
      ACTIVE.has(value.status) && Date.now() >= value.expiresAt
        ? { ...value, status: Status.Expired, code: undefined }
        : { ...value };
    const statusChanged = pending?.pendingId !== next.pendingId || pending.status !== next.status;
    if (statusChanged || pending.revision !== next.revision) {
      action += 1;
      allowing = denying = false;
      errorCode = '';
    }
    pending = next;
    clearTimeout(expiryTimer);
    if (ACTIVE.has(next.status))
      expiryTimer = setTimeout(
        () => accept({ ...next, status: Status.Expired, code: undefined }),
        Math.max(0, next.expiresAt - Date.now()) + 1,
      );
    render();
    if (
      statusChanged &&
      !ACTIVE.has(next.status) &&
      next.status !== Status.Connected &&
      next.status !== Status.Waiting
    )
      onNotice?.(
        next.code && next.code !== 'CONNECTION_REJECTED'
          ? errorText(next.code)
          : t(`webConnectionStatus_${next.status}`),
      );
  }
  async function decide(snapshot, operation, decision, reason) {
    try {
      const result = await request(WebConnectionMessage.Decide, {
        pendingId: snapshot.pendingId,
        expectedRevision: snapshot.revision,
        decision,
        ...(reason ? { reason } : {}),
      });
      if (disposed || pending?.pendingId !== snapshot.pendingId || action !== operation) return;
      if (Object.hasOwn(result, 'connectionPending')) accept(result.connectionPending);
    } catch (failure) {
      if (!disposed && pending?.pendingId === snapshot.pendingId && action === operation)
        errorCode = failure.code || 'GENERIC';
    } finally {
      if (!disposed && action === operation) {
        allowing = denying = false;
        render();
      }
    }
  }
  allow.addEventListener('click', () => {
    if (
      !active() ||
      pending.status !== Status.Awaiting ||
      allowing ||
      denying ||
      pending.requiresAction === false
    )
      return;
    const snapshot = { ...pending };
    const operation = ++action;
    let permission;
    try {
      const url = new URL(snapshot.origin);
      // This must remain in the native button click stack, before any await.
      permission = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    } catch {
      permission = Promise.resolve(false);
    }
    allowing = true;
    errorCode = '';
    render();
    void Promise.resolve(permission)
      .catch(() => false)
      .then(granted => {
        if (!current(snapshot, operation)) return;
        return decide(
          snapshot,
          operation,
          granted ? 'allow' : 'deny',
          granted ? undefined : 'permission-denied',
        );
      });
  });
  deny.addEventListener('click', () => {
    if (!active() || denying) return;
    const snapshot = { ...pending };
    const operation = ++action;
    allowing = false;
    denying = true;
    errorCode = '';
    render();
    void decide(snapshot, operation, 'deny');
  });
  return {
    accept,
    dispose: () => {
      disposed = true;
      action += 1;
      clearTimeout(expiryTimer);
      root.classList.add('hidden');
    },
  };
}
