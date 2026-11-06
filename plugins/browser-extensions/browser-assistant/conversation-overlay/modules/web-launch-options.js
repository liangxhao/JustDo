import { t } from './options-i18n.js';

export const WebLaunchOptionsMessage = {
  List: 'web-launch:sites:list',
  Save: 'web-launch:sites:save',
  Observations: 'web-launch:observations:list',
  Abandon: 'web-launch:launch:abandon',
};

export function parseWebLaunchOrigin(value) {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin === 'null'
  )
    throw new Error('INVALID_ORIGIN');
  return { origin: url.origin, permission: `${url.protocol}//${url.hostname}/*` };
}

export function createWebLaunchOptions({
  document,
  chrome: browser = globalThis.chrome,
  confirm = message => globalThis.confirm(message),
}) {
  const root = document.getElementById('webLaunchSites');
  if (!root || !browser?.runtime?.sendMessage) return { dispose() {} };
  let disposed = false;
  let busy = false;
  let generation = 0;
  let revision = 0;
  let loaded = false;
  const make = (tag, text, parent = root) => {
    const node = document.createElement(tag);
    if (text) node.textContent = t(text);
    parent.append(node);
    return node;
  };
  make('h2', 'webLaunchSitesTitle');
  make('p', 'webLaunchSitesHint').className = 'muted';
  const label = make('label', 'webLaunchOrigin');
  label.htmlFor = 'webLaunchOrigin';
  const originInput = make('input');
  originInput.type = 'url';
  originInput.id = 'webLaunchOrigin';
  originInput.placeholder = 'https://business.internal';
  originInput.autocomplete = 'off';
  const addChoices = make('div');
  const choice = (key, parent = addChoices) => {
    const element = make('label', null, parent);
    element.className = 'web-launch-choice';
    const input = make('input', null, element);
    input.type = 'checkbox';
    make('span', key, element);
    return input;
  };
  const allowSend = choice('webLaunchAllowSend');
  const allowResult = choice('webLaunchAllowResult');
  const add = make('button', 'webLaunchAddSite');
  add.type = 'button';
  add.className = 'primary';
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
    const result = await browser.runtime.sendMessage({ type, ...params });
    if (!result || result.ok === false)
      throw Object.assign(new Error('Web launch settings unavailable'), {
        code: result?.code || 'GENERIC',
      });
    return result;
  };
  function controls() {
    add.disabled = busy || !loaded || !originInput.value.trim();
    refreshButton.disabled = busy;
    originInput.disabled = busy;
    allowSend.disabled = busy || !loaded;
    allowResult.disabled = busy || !loaded;
    for (const node of sites.querySelectorAll('button,input')) node.disabled = busy;
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
  function renderSites(policies) {
    sites.replaceChildren();
    for (const policy of [...policies].sort((a, b) => a.origin.localeCompare(b.origin))) {
      if (!policy.enabled) continue;
      const row = make('div', null, sites);
      row.className = 'web-launch-site';
      const heading = make('strong', null, row);
      heading.textContent = policy.origin;
      const send = choice('webLaunchAllowSend', row);
      send.checked = policy.allowSend;
      const result = choice('webLaunchAllowResult', row);
      result.checked = policy.allowResult;
      const update = () =>
        void perform(() =>
          save({
            origin: policy.origin,
            enabled: true,
            allowSend: send.checked,
            allowResult: result.checked,
          }),
        );
      send.addEventListener('change', update);
      result.addEventListener('change', update);
      const revoke = make('button', 'webLaunchRevoke', row);
      revoke.type = 'button';
      revoke.addEventListener(
        'click',
        () =>
          void perform(() =>
            save({ origin: policy.origin, enabled: false, allowSend: false, allowResult: false }),
          ),
      );
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
  originInput.addEventListener('input', controls);
  add.addEventListener('click', () => {
    if (busy || !loaded) return;
    let parsed;
    try {
      parsed = parseWebLaunchOrigin(originInput.value);
    } catch {
      setFeedback('webLaunchInvalidOrigin', true);
      return;
    }
    // Keep the permission request directly in the trusted click stack.
    let permission;
    try {
      permission = browser.permissions.request({ origins: [parsed.permission] });
    } catch {
      setFeedback('webLaunchPermissionDenied', true);
      return;
    }
    void perform(async () => {
      if (!(await permission))
        throw Object.assign(new Error('Permission refused'), { code: 'PERMISSION_DENIED' });
      if (disposed) return;
      await save({
        origin: parsed.origin,
        enabled: true,
        allowSend: allowSend.checked,
        allowResult: allowResult.checked,
      });
      if (!disposed) {
        originInput.value = '';
        allowSend.checked = false;
        allowResult.checked = false;
      }
      return 'webLaunchReloadPage';
    });
  });
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
