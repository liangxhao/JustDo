import { WebLaunchSendMode } from '../../contracts/webLaunch.ts';
import { t } from './options-i18n.js';

export const WebLaunchOptionsMessage = {
  List: 'web-launch:sites:list',
  Save: 'web-launch:sites:save',
  SendMode: 'web-launch:sites:send-mode',
  Observations: 'web-launch:observations:list',
  Abandon: 'web-launch:launch:abandon',
};

const SEND_MODE_LABELS = {
  [WebLaunchSendMode.Website]: 'webLaunchSendModeWebsite',
  [WebLaunchSendMode.Direct]: 'webLaunchSendModeDirect',
  [WebLaunchSendMode.Draft]: 'webLaunchSendModeDraft',
};

const readSendMode = value =>
  typeof value === 'string' && Object.hasOwn(SEND_MODE_LABELS, value)
    ? value
    : WebLaunchSendMode.Website;

export function createWebLaunchOptions({
  document,
  chrome = globalThis.chrome,
  confirm = message => globalThis.confirm(message),
}) {
  const root = document.getElementById('webLaunchSites');
  if (!root || !chrome?.runtime?.sendMessage) return { dispose() {} };
  let disposed = false;
  let busy = false;
  let generation = 0;
  let revision = 0;
  let sendMode = WebLaunchSendMode.Website;
  let loaded = false;
  const make = (tag, text, parent = root) => {
    const node = document.createElement(tag);
    if (text) node.textContent = t(text);
    parent.append(node);
    return node;
  };
  make('h2', 'webLaunchSitesTitle');
  make('p', 'webLaunchSitesHint').className = 'muted';
  const modeRow = make('div');
  modeRow.className = 'web-launch-send-mode';
  const modeLabel = make('label', 'webLaunchSendMode', modeRow);
  modeLabel.htmlFor = 'webLaunchSendMode';
  const modeSelect = make('select', null, modeRow);
  modeSelect.id = modeLabel.htmlFor;
  for (const [value, label] of Object.entries(SEND_MODE_LABELS)) {
    make('option', label, modeSelect).value = value;
  }
  const refreshButton = make('button', 'webLaunchRefresh');
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', () => {
    if (!busy) void refresh();
  });
  const feedback = make('p');
  feedback.setAttribute('role', 'status');
  const sites = make('div');
  const observations = make('div');
  const setFeedback = (key, error = false) => {
    feedback.textContent = t(key);
    feedback.dataset.error = String(error);
  };
  const request = async (type, params = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...params });
    if (!result || result.ok === false)
      throw Object.assign(new Error('Web launch settings unavailable'), {
        code: result?.code || 'GENERIC',
      });
    return result;
  };
  function controls() {
    refreshButton.disabled = busy;
    modeSelect.disabled = busy || !loaded;
    if (!busy) modeSelect.value = sendMode;
    for (const node of sites.querySelectorAll('button')) node.disabled = busy || !loaded;
    for (const node of observations.querySelectorAll('button')) node.disabled = busy;
  }
  function showFailure(code) {
    const key =
      code === 'POLICY_CONFLICT' || code === 'SITE_CONFLICT' || code === 'REVISION_CONFLICT'
        ? 'webLaunchConflict'
        : code === 'PERMISSION_DENIED'
          ? 'webLaunchPermissionDenied'
          : 'webLaunchSettingsFailed';
    setFeedback(key, true);
  }
  async function save(policy) {
    return request(WebLaunchOptionsMessage.Save, { ...policy, expectedRevision: revision });
  }
  async function perform(task) {
    if (busy || disposed) return;
    busy = true;
    generation += 1;
    controls();
    try {
      const success = await task();
      if (!disposed) setFeedback(typeof success === 'string' ? success : 'webLaunchSaved');
    } catch (failure) {
      if (!disposed) showFailure(failure.code);
    } finally {
      busy = false;
      if (!disposed) await refresh();
    }
  }
  modeSelect.addEventListener('change', () => {
    const selected = readSendMode(modeSelect.value);
    if (!loaded || busy || selected === sendMode) return;
    const restoreFocus = document.activeElement === modeSelect;
    void perform(async () => {
      const result = await request(WebLaunchOptionsMessage.SendMode, {
        sendMode: selected,
        expectedRevision: revision,
      });
      sendMode = readSendMode(result.sendMode);
      return 'webLaunchSendModeSaved';
    }).then(() => {
      if (
        restoreFocus &&
        !disposed &&
        !modeSelect.disabled &&
        document.activeElement === document.body
      )
        modeSelect.focus();
    });
  });
  function renderSites(policies) {
    sites.replaceChildren();
    for (const policy of [...policies].sort((a, b) => a.origin.localeCompare(b.origin))) {
      if (!policy.enabled) continue;
      const row = make('div', null, sites);
      row.className = 'web-launch-site web-launch-site-access';
      const heading = make('strong', null, row);
      heading.textContent = policy.origin;
      const revoke = make('button', 'webLaunchRevoke', row);
      revoke.type = 'button';
      revoke.addEventListener(
        'click',
        () =>
          void perform(() =>
            save({ origin: policy.origin, enabled: false, allowSend: false, allowResult: false }),
          ),
      );
      if (!policy.allowSend || !policy.allowResult)
        make('p', 'webLaunchReconnect', row).className = 'muted';
    }
    if (!policies.some(policy => policy.enabled))
      make('p', 'webLaunchNoSites', sites).className = 'muted';
  }
  function renderObservations(items) {
    observations.replaceChildren();
    const unknown = items.filter(item => (item.receipt || item).execution?.status === 'unknown');
    if (!unknown.length) return;
    make('h3', 'webLaunchObservations', observations);
    for (const item of unknown) {
      const receipt = item.receipt || item;
      const row = make('div', null, observations);
      row.className = 'web-launch-site';
      const source = make('p', null, row);
      source.textContent = item.origin || t('webLaunchUnknownSource');
      const abandon = make('button', 'webLaunchAbandon', row);
      abandon.type = 'button';
      abandon.addEventListener('click', () => {
        if (confirm(t('webLaunchAbandonConfirm')))
          void perform(() =>
            request(WebLaunchOptionsMessage.Abandon, { launchId: receipt.launchId, confirm: true }),
          );
      });
    }
  }
  async function refresh() {
    const next = ++generation;
    try {
      const [result, observed] = await Promise.all([
        request(WebLaunchOptionsMessage.List),
        request(WebLaunchOptionsMessage.Observations).catch(() => null),
      ]);
      if (disposed || next !== generation) return;
      revision = result.sitesRevision ?? result.revision ?? 0;
      sendMode = readSendMode(result.sendMode);
      const policies = result.policies ?? result.sites ?? [];
      loaded = true;
      renderSites(policies);
      const items = result.observations ?? observed?.observations ?? [];
      renderObservations(Array.isArray(items) ? items : (items.observations ?? []));
    } catch (failure) {
      if (!disposed && next === generation) {
        loaded = false;
        showFailure(failure.code);
      }
    }
    if (!disposed && next === generation) controls();
  }
  controls();
  void refresh();
  return {
    refresh,
    dispose: () => {
      disposed = true;
      generation += 1;
    },
  };
}
