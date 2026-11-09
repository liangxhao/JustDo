import { sidePanelText as t } from './sidepanel-i18n.js';

export const WebConnectionMessage = {
  Decide: 'web-launch:connection:decide',
};
const Status = {
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
export function createWebConnectionPanel({ document, chrome, request }) {
  const root = document.getElementById('webConnectionCard');
  if (!root) return { accept() {}, prepared() {}, dispose() {} };
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
  const current = (snapshot, operation) =>
    !disposed &&
    action === operation &&
    pending?.pendingId === snapshot.pendingId &&
    pending.revision === snapshot.revision &&
    active();
  function render() {
    root.classList.toggle('hidden', !pending);
    if (!pending) return;
    origin.textContent = pending.origin;
    const expired = ACTIVE.has(pending.status) && Date.now() >= pending.expiresAt;
    const state = expired ? Status.Expired : allowing ? Status.Granting : pending.status;
    status.textContent = t(`webConnectionStatus_${state}`);
    allow.hidden = deny.hidden = !ACTIVE.has(state);
    allow.disabled =
      !active() ||
      pending.status !== Status.Awaiting ||
      allowing ||
      denying ||
      pending.requiresAction === false;
    deny.disabled = !active() || denying;
    const code = errorCode || pending.code || '';
    const key = `webConnectionError_${code}`;
    error.textContent =
      code && !(code === 'CONNECTION_REJECTED' && pending.status === Status.Rejected)
        ? t(key) === key
          ? t('webConnectionError_GENERIC')
          : t(key)
        : '';
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
    if (pending?.pendingId === value.pendingId && value.revision < pending.revision) return;
    if (
      pending?.pendingId !== value.pendingId ||
      pending.revision !== value.revision ||
      !ACTIVE.has(value.status)
    ) {
      action += 1;
      allowing = denying = false;
      errorCode = '';
    }
    pending = { ...value };
    clearTimeout(expiryTimer);
    if (ACTIVE.has(pending.status))
      expiryTimer = setTimeout(
        () => {
          action += 1;
          allowing = denying = false;
          render();
        },
        Math.max(0, pending.expiresAt - Date.now()) + 1,
      );
    render();
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
    prepared: () => {
      if (pending?.status === Status.Connected) accept(null);
    },
    dispose: () => {
      disposed = true;
      action += 1;
      clearTimeout(expiryTimer);
    },
  };
}
