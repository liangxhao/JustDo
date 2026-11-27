import { WebLaunchMethod } from '../../contracts/webLaunch.ts';
import { openTabSidePanel } from './tab-side-panel.js';
import {
  WEB_CONNECTION,
  WEB_RUNTIME,
  exactOrigin,
  hasWebsiteLaunchGrant,
  inputDigest,
  normalizeInput,
  publicErrorCode,
  validExternalDocumentSender,
  validIdentifier,
} from './web-launch-security.js';

const LIFETIME = 120_000;
const WINDOW_CHECK_INTERVAL = 5_000;
const Status = Object.freeze({
  Waiting: 'waiting-for-window',
  WaitingForConnection: 'waiting-for-connection',
  Awaiting: 'awaiting-consent',
  Granting: 'granting',
  Connected: 'connected',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Expired: 'expired',
});
const pendingDecision = value => [Status.Awaiting, Status.Granting].includes(value.status);
const showDecision = value => !value.reuseGrant && !value.continuationStatus && pendingDecision(value) &&
  (value.requiresAction || value.code || value.status === Status.Granting);
const needsPolicy = value =>
  [Status.Waiting, Status.Awaiting].includes(value.status) && value.sitesRevision === undefined;
const live = value =>
  (value.status === Status.Waiting ||
    pendingDecision(value) ||
    value.status === Status.Connected) &&
  !value.claimed;
const hasOpenContinuation = value => live(value) && !value.continuationStatus;
const competingConnection = supportsWaiting => ({
  ok: true,
  connectionPending: supportsWaiting
    ? { status: Status.WaitingForConnection }
    : { status: Status.Expired, code: 'CONNECTION_PENDING' },
});
const sameSource = (value, sender) =>
  value.source.origin === sender.origin &&
  value.source.documentId === sender.documentId &&
  value.source.tabId === sender.tab.id &&
  value.source.windowId === sender.tab.windowId;
const inPanelTab = (value, { tabId, windowId }) =>
  value.source.tabId === tabId && value.source.windowId === windowId;
const metadata = value =>
  value
    ? {
        pendingId: value.pendingId,
        revision: value.revision,
        origin: value.source.origin,
        expiresAt: value.expiresAt,
        status: value.continuationStatus ?? value.status,
        requiresAction: value.requiresAction === true,
        ...(value.code && !value.continuationStatus ? { code: value.code } : {}),
      }
    : null;
const retryableGrantErrors = new Set([
  'APP_NOT_RUNNING', 'CONNECTION_UNAVAILABLE', 'NATIVE_HOST_UNAVAILABLE',
  'REQUEST_TIMEOUT', 'STORAGE_UNAVAILABLE',
]);

/** Untrusted external messages can request a connection, never a native operation. */
export function createWebLaunchConnections({
  chromeApi,
  cryptoApi,
  store,
  client,
  readSites,
  currentSite,
  applySites,
  cacheWebsiteGrants,
  registerScripts,
  hasCachedWebsiteGrant,
  notify,
  windowBusy,
  reconcileWindowWork,
  now = () => Date.now(),
}) {
  const provisional = new Map();
  const tabEpoch = new Map();
  const retired = new Set();
  const refreshes = new Map();
  const windowChecks = new Map();
  const granting = new Map();
  const expired = value => value.expiresAt <= now();
  const mayReuseGrant = value => [Status.Awaiting, Status.Waiting].includes(value.status) &&
    hasWebsiteLaunchGrant(currentSite(value.source.origin));
  const retire = id => {
    retired.add(id);
    if (retired.size > 128) retired.delete(retired.values().next().value);
  };
  function endContinuation(value, status) {
    if (!hasOpenContinuation(value)) return false;
    retire(value.pendingId);
    value.requiresAction = false;
    delete value.input;
    if (value.status === Status.Granting && !value.reuseGrant) {
      // Page navigation and unbinding can close the draft independently of a trusted Allow.
      value.continuationStatus = status;
    } else {
      value.status = status;
      value.revision += 1;
    }
  }
  function collect(values) {
    for (const value of Object.values(values)) {
      if (live(value) && expired(value)) {
        value.status = value.continuationStatus ?? Status.Expired;
        value.revision += 1;
        value.requiresAction = false;
        if (value.continuationStatus) delete value.code;
        delete value.continuationStatus;
        delete value.input;
      }
    }
    const retired = Object.values(values)
      .filter(value => !live(value))
      .sort((a, b) => a.expiresAt - b.expiresAt);
    for (const value of retired.slice(0, Math.max(0, Object.keys(values).length - 64)))
      delete values[value.pendingId];
  }
  async function change(pendingId, action) {
    const { result, changed, wasVisible } = await store(values => {
      collect(values);
      const value = values[pendingId];
      if (!value) throw { code: 'EXPIRED' };
      const wasVisible = showDecision(value);
      const changed = action(value) !== false;
      return { result: structuredClone(value), changed, wasVisible };
    });
    if (changed && (!pendingDecision(result) || showDecision(result) || result.continuationStatus))
      notify(result.source, metadata(result));
    else if (changed && wasVisible) notify(result.source, null);
    return result;
  }
  async function current(panel) {
    return store(values => {
      collect(values);
      const value = Object.values(values)
        .reverse()
        .filter(item => inPanelTab(item, panel) && showDecision(item))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return metadata(value);
    });
  }
  function deferConsent(item) {
    if (item.status === Status.Waiting) return false;
    item.status = Status.Waiting;
    item.requiresAction = false;
    item.revision += 1;
    delete item.code;
  }
  function checkWindowWork(windowId) {
    const checked = windowChecks.get(windowId);
    if (checked !== undefined && now() - checked < WINDOW_CHECK_INTERVAL) return;
    windowChecks.set(windowId, now());
    if (windowChecks.size > 128) windowChecks.delete(windowChecks.keys().next().value);
    void reconcileWindowWork(windowId).catch(() => {});
  }
  async function refreshConsent(value) {
    if (!needsPolicy(value) && !mayReuseGrant(value)) return value;
    const { windowId } = value.source;
    let policies;
    let site;
    let reuseGrant;
    try {
      policies = await readSites();
      site = policies.sites.find(site => site.origin === value.source.origin);
      reuseGrant = hasWebsiteLaunchGrant(site) && await hasHostPermission(value);
    } catch (error) {
      return change(value.pendingId, item => {
        const code = publicErrorCode(error);
        if (!needsPolicy(item) || item.code === code) return false;
        item.code = code;
        item.revision += 1;
      });
    }
    const pending = await change(value.pendingId, item => {
      if (item.revision !== value.revision || (!needsPolicy(item) && !(reuseGrant && mayReuseGrant(item))))
        return false;
      if (!reuseGrant && windowBusy(windowId)) {
        checkWindowWork(windowId);
        return deferConsent(item);
      }
      item.status = reuseGrant ? Status.Granting : Status.Awaiting;
      item.sitesRevision = policies.revision;
      item.siteRevision = site?.revision ?? null;
      item.reuseGrant = reuseGrant;
      item.requiresAction = !reuseGrant;
      item.revision += 1;
      delete item.code;
    });
    return pending.status === Status.Granting ? completeGrant(pending) : pending;
  }
  async function find(message, sender) {
    return store(values => {
      collect(values);
      const value = message.pendingId
        ? values[message.pendingId]
        : Object.values(values)
            .reverse()
            .find(item => item.bindingId === message.bindingId && sameSource(item, sender));
      if (!value || !sameSource(value, sender)) throw { code: 'EXPIRED' };
      return structuredClone(value);
    });
  }
  async function sourceActive(value) {
    const tab = await chromeApi.tabs.get(value.source.tabId);
    if (tab.windowId !== value.source.windowId || exactOrigin(tab.url) !== value.source.origin)
      throw { code: 'EXPIRED' };
    // Exact-document execution fails on a reload, even when URL/origin are unchanged.
    const results = await chromeApi.scripting.executeScript({
      target: { tabId: value.source.tabId, documentIds: [value.source.documentId] },
      func: () => ({ origin: location.origin, active: !document.prerendering }),
    });
    if (
      !results?.some(
        result =>
          result.documentId === value.source.documentId &&
          result.result?.origin === value.source.origin &&
          result.result.active === true,
      )
    )
      throw { code: 'EXPIRED' };
  }
  function injectBridge(source) {
    return chromeApi.scripting.executeScript({
      target: { tabId: source.tabId, documentIds: [source.documentId] },
      files: ['web-launch-content.js'],
    });
  }
  function hasHostPermission({ source }) {
    const origin = new URL(source.origin);
    return chromeApi.permissions.contains({ origins: [`${origin.protocol}//${origin.hostname}/*`] });
  }
  async function probeConnection(sender) {
    if (
      !(await hasHostPermission({ source: sender })) ||
      !(await hasCachedWebsiteGrant(sender.origin, { refresh: true }))
    )
      return false;
    const source = {
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      documentId: sender.documentId,
      origin: sender.origin,
    };
    const current = await chromeApi.tabs
      .sendMessage(
        source.tabId,
        { type: `${WEB_RUNTIME}bridge-present` },
        { documentId: source.documentId },
      )
      .catch(() => null);
    if (current?.active === true) return true;
    // Repair an already granted document without replaying a click or granting access.
    const policies = await readSites();
    if (!hasWebsiteLaunchGrant(policies.sites.find(site => site.origin === source.origin)))
      return false;
    await sourceActive({ source });
    await injectBridge(source);
    return true;
  }
  async function assertGrant(value) {
    return store(values => {
      collect(values);
      const current = values[value.pendingId];
      if (!current || current.status !== Status.Granting || current.revision !== value.revision)
        throw { code: 'EXPIRED' };
      return current.continuationStatus;
    });
  }
  function assertLive(value) {
    if (
      retired.has(value.pendingId) ||
      expired(value) ||
      (tabEpoch.get(value.source.tabId) ?? value.epoch ?? 0) !== (value.epoch ?? 0)
    )
      throw { code: 'EXPIRED' };
  }
  async function refresh(panel) {
    const key = `${panel.windowId}/${panel.tabId}`;
    const prior = refreshes.get(key);
    if (prior && now() - prior.at < WINDOW_CHECK_INTERVAL) return;
    refreshes.set(key, { at: now() });
    if (refreshes.size > 128) refreshes.delete(refreshes.keys().next().value);
    const pending = await store(values =>
      structuredClone(
        Object.values(values).filter(
          item =>
            inPanelTab(item, panel) &&
            !expired(item) &&
            (needsPolicy(item) || item.status === Status.Granting || mayReuseGrant(item)),
        ),
      ),
    );
    await Promise.allSettled(pending.map(value =>
      value.status === Status.Granting ? completeGrant(value) : refreshConsent(value),
    ));
  }
  async function decide(message) {
    if (
      !validIdentifier(message.pendingId) ||
      !Number.isSafeInteger(message.expectedRevision) ||
      !['allow', 'deny'].includes(message.decision) ||
      Object.keys(message).some(
        key =>
          ![
            'type',
            'pendingId',
            'expectedRevision',
            'decision',
            'reason',
            'panelInstanceId',
            'tabId',
            'windowId',
          ].includes(key),
      )
    )
      throw { code: 'INVALID_REQUEST' };
    const value = await change(message.pendingId, item => {
      if (!inPanelTab(item, message)) throw { code: 'FORBIDDEN' };
      if (message.decision === 'deny') {
        if (item.claimed) throw { code: 'TOO_LATE' };
        if (message.expectedRevision > item.revision || !live(item)) throw { code: 'EXPIRED' };
      } else if (item.revision !== message.expectedRevision || !pendingDecision(item))
        throw { code: 'EXPIRED' };
      if (message.decision === 'allow' && (item.status !== Status.Awaiting || !item.requiresAction))
        throw { code: 'EXPIRED' };
      if (message.decision === 'allow') assertLive(item);
      item.status = message.decision === 'deny' ? Status.Rejected : Status.Granting;
      item.requiresAction = false;
      item.revision += 1;
      if (message.decision === 'deny') {
        retire(item.pendingId);
        delete item.continuationStatus;
        item.code =
          message.reason === 'permission-denied' ? 'PERMISSION_REQUIRED' : 'CONNECTION_REJECTED';
        delete item.input;
      }
    });
    const pending = message.decision === 'deny' ? value : await completeGrant(value);
    return { ok: true, connectionPending: metadata(pending) };
  }
  async function saveGrant(value) {
    const { origin } = value.source;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const policies = await readSites();
      await assertGrant(value);
      const existing = policies.sites.find(site => site.origin === origin);
      if (hasWebsiteLaunchGrant(existing)) return { revision: policies.revision, updated: false };
      if (value.reuseGrant || (value.siteRevision === undefined
        ? policies.revision !== value.sitesRevision
        : (existing?.revision ?? null) !== value.siteRevision))
        throw { code: 'POLICY_CONFLICT' };
      try {
        const updated = await client.request(WebLaunchMethod.SitesWrite, {
          expectedRevision: policies.revision,
          origin,
          enabled: true,
          allowSend: true,
          allowResult: true,
        });
        if (!Array.isArray(updated?.sites)) throw { code: 'CONNECTION_UNAVAILABLE' };
        applySites(updated);
        return { revision: updated.revision, updated: true };
      } catch (error) {
        if (publicErrorCode(error) !== 'POLICY_CONFLICT' || attempt === 2) throw error;
      }
    }
  }
  function completeGrant(value) {
    const id = value.pendingId;
    if (granting.has(id)) return granting.get(id);
    const completion = finishGrant(value).finally(() => granting.delete(id));
    granting.set(id, completion);
    return completion;
  }
  async function finishGrant(value) {
    let policies;
    try {
      await assertGrant(value);
      if (!(await hasHostPermission(value))) return value;
      policies = await saveGrant(value);
      // Persistence and delivery to this particular document have separate lifetimes.
      await (policies.updated ? registerScripts() : cacheWebsiteGrants()).catch(() => {});
      if (!(await assertGrant(value))) {
        assertLive(value);
        await sourceActive(value);
        if (!(await assertGrant(value))) await injectBridge(value.source);
      }
      value = await change(value.pendingId, item => {
        if (item.status !== Status.Granting || item.revision !== value.revision)
          throw { code: 'EXPIRED' };
        if (item.continuationStatus) {
          item.status = item.continuationStatus;
        } else {
          assertLive(item);
          item.status = Status.Connected;
          item.policyRevision = policies.revision;
        }
        delete item.continuationStatus;
        delete item.code;
        item.revision += 1;
      });
      if (value.status !== Status.Connected) return value;
      const ready = await chromeApi.tabs.sendMessage(
        value.source.tabId,
        {
          type: `${WEB_RUNTIME}connection-ready`,
          pendingId: value.pendingId,
          bindingId: value.bindingId,
          bindingRevision: value.bindingRevision,
          payloadDigest: value.payloadDigest,
          expiresAt: value.expiresAt,
        },
        { documentId: value.source.documentId },
      );
      if (!ready?.ok) throw { code: 'EXPIRED' };
      return value;
    } catch (error) {
      const code = publicErrorCode(error);
      if (!policies && retryableGrantErrors.has(code) && error?.code) {
        return change(value.pendingId, item => {
          if (item.status !== Status.Granting || item.revision !== value.revision || item.code === code)
            return false;
          item.code = code;
          item.revision += 1;
        });
      }
      await change(value.pendingId, item => {
        if (![Status.Granting, Status.Connected].includes(item.status) ||
            item.revision !== value.revision || item.claimed)
          return false;
        item.status = item.continuationStatus ?? Status.Expired;
        if (item.continuationStatus) delete item.code;
        else item.code = code;
        delete item.continuationStatus;
        item.revision += 1;
        delete item.input;
      }).catch(() => {});
      throw error;
    }
  }
  function handleExternalMessage(message, sender, reply) {
    if (
      !validExternalDocumentSender(sender, message?.op === 'cancel') ||
      message?.type !== WEB_CONNECTION ||
      !['probe', 'request', 'query', 'cancel'].includes(message.op)
    ) {
      reply({ ok: false, code: 'FORBIDDEN' });
      return false;
    }
    const fields = {
      probe: [],
      request: ['bindingId', 'bindingRevision', 'payloadDigest', 'input', 'connectionWaitStatus'],
      query: ['pendingId', 'bindingId'],
      cancel: ['pendingId', 'bindingId'],
    };
    if (
      Object.keys(message).some(key => !['type', 'op', ...fields[message.op]].includes(key)) ||
      (message.op !== 'probe' && !validIdentifier(message.pendingId ?? message.bindingId))
    ) {
      reply({ ok: false, code: 'INVALID_REQUEST' });
      return false;
    }
    const done = operation => {
      void operation.then(reply, error =>
        reply({
          ok: false,
          code: publicErrorCode(error),
        }),
      );
      return true;
    };
    if (message.op === 'probe')
      return done(
        probeConnection(sender).then(
          connected => ({ ok: true, connected, connectionWaitStatus: true }),
          () => ({ ok: true, connected: false, connectionWaitStatus: true }),
        ),
      );
    if (message.op === 'query')
      return done(
        find(message, sender).catch(error => {
          if (error?.code === 'EXPIRED' && !message.pendingId && !provisional.has(sender.tab.windowId))
            return null;
          throw error;
        }).then(async value => {
          if (!value) {
            const hasCompetingConnection = await store(values => Object.values(values).some(
              item => item.source.windowId === sender.tab.windowId && !expired(item) && hasOpenContinuation(item),
            ));
            return hasCompetingConnection ? competingConnection(false)
              : { ok: true, connectionPending: { status: Status.Expired } };
          }
          const busy = value.status === Status.Waiting && windowBusy(value.source.windowId);
          if (busy) checkWindowWork(value.source.windowId);
          const shouldRefresh = value.status === Status.Waiting && !value.code && !busy;
          if (value.status === Status.Granting || (!shouldRefresh && mayReuseGrant(value)))
            void refresh(value.source).catch(() => {});
          return {
            ok: true,
            connectionPending: metadata(shouldRefresh ? await refreshConsent(value) : value),
          };
        }),
      );
    if (message.op === 'cancel')
      return done(
        find(message, sender)
          .then(value =>
            change(value.pendingId, item => {
              if (item.claimed) throw { code: 'TOO_LATE' };
              return endContinuation(item, Status.Cancelled);
            }),
          )
          .then(value => ({ ok: true, connectionPending: metadata(value) })),
      );
    const input = normalizeInput(message.input);
    if (
      !input ||
      !Number.isSafeInteger(message.bindingRevision) ||
      message.bindingRevision < 1 ||
      (message.connectionWaitStatus !== undefined && message.connectionWaitStatus !== true) ||
      !/^[a-f0-9]{64}$/u.test(message.payloadDigest ?? '')
    ) {
      reply({ ok: false, code: 'INVALID_REQUEST' });
      return false;
    }
    if (provisional.has(sender.tab.windowId)) {
      reply(competingConnection(message.connectionWaitStatus));
      return false;
    }
    provisional.set(sender.tab.windowId, sender.tab.id);
    const epoch = tabEpoch.get(sender.tab.id) ?? 0;
    let opened;
    try {
      opened = openTabSidePanel(chromeApi, sender.tab.id);
    } catch {
      provisional.delete(sender.tab.windowId);
      reply({ ok: false, code: 'PANEL_OPEN_FAILED' });
      return false;
    }
    return done(
      Promise.resolve(opened)
        .catch(() => {
          throw { code: 'PANEL_OPEN_FAILED' };
        })
        .then(async () => {
          if (
            (tabEpoch.get(sender.tab.id) ?? 0) !== epoch ||
            (await inputDigest(input, cryptoApi)) !== message.payloadDigest
          )
            throw { code: 'EXPIRED' };
          let value = await store(values => {
            if ((tabEpoch.get(sender.tab.id) ?? 0) !== epoch) throw { code: 'EXPIRED' };
            collect(values);
            const existing = Object.values(values).find(
              item => item.source.windowId === sender.tab.windowId && hasOpenContinuation(item),
            );
            if (existing) {
              if (
                !sameSource(existing, sender) ||
                existing.bindingId !== message.bindingId ||
                existing.bindingRevision !== message.bindingRevision ||
                existing.payloadDigest !== message.payloadDigest
              )
                return undefined;
              return structuredClone(existing);
            }
            const bytes = Object.values(values).reduce(
              (total, item) =>
                total +
                (item.input ? new TextEncoder().encode(JSON.stringify(item.input)).byteLength : 0),
              0,
            );
            if (
              Object.keys(values).length >= 100 ||
              bytes + new TextEncoder().encode(JSON.stringify(input)).byteLength > 2 * 1024 * 1024
            )
              throw { code: 'CAPACITY_EXCEEDED' };
            const pendingId = cryptoApi.randomUUID();
            const value = {
              pendingId,
              revision: 1,
              createdAt: now(),
              expiresAt: now() + LIFETIME,
              status: windowBusy(sender.tab.windowId) ? Status.Waiting : Status.Awaiting,
              requiresAction: false,
              epoch,
              source: {
                origin: sender.origin,
                tabId: sender.tab.id,
                windowId: sender.tab.windowId,
                documentId: sender.documentId,
              },
              bindingId: message.bindingId,
              bindingRevision: message.bindingRevision,
              payloadDigest: message.payloadDigest,
              input,
            };
            values[pendingId] = value;
            return structuredClone(value);
          });
          if (!value) return competingConnection(message.connectionWaitStatus);
          if ((tabEpoch.get(sender.tab.id) ?? 0) !== epoch) throw { code: 'EXPIRED' };
          value = await refreshConsent(value);
          return { ok: true, connectionPending: metadata(value) };
        })
        .finally(() => provisional.delete(sender.tab.windowId)),
    );
  }
  async function consume(message, sender) {
    const value = await store(values => {
      collect(values);
      const item = values[message.pendingId];
      if (item) assertLive(item);
      if (
        !item ||
        !sameSource(item, sender) ||
        item.status !== Status.Connected ||
        item.claimed ||
        item.bindingId !== message.bindingId ||
        item.bindingRevision !== message.bindingRevision ||
        item.payloadDigest !== message.payloadDigest ||
        JSON.stringify(item.input) !== JSON.stringify(normalizeInput(message.input))
      )
        throw { code: 'EXPIRED' };
      item.claimed = true;
      item.revision += 1;
      delete item.input;
      return structuredClone(item);
    });
    notify(value.source, metadata(value));
    return { connectionOnly: true, expectedPolicyRevision: value.policyRevision };
  }
  function invalidateTab(tabId) {
    tabEpoch.set(tabId, (tabEpoch.get(tabId) ?? 0) + 1);
    if (tabEpoch.size > 256) tabEpoch.delete(tabEpoch.keys().next().value);
    void store(values => {
      const invalidated = [];
      for (const value of Object.values(values))
        if (value.source.tabId === tabId && endContinuation(value, Status.Expired) !== false) {
          invalidated.push({ source: value.source, pending: metadata(value) });
        }
      return invalidated;
    })
      .then(invalidated => {
        for (const { source, pending } of invalidated) notify(source, pending);
      })
      .catch(() => {});
  }
  async function resumeGrants() {
    const pending = await store(values => {
      collect(values);
      return structuredClone(Object.values(values).filter(item => item.status === Status.Granting));
    });
    await Promise.allSettled(pending.map(async value => {
      // Recheck if an earlier attempt was already running when the event arrived.
      const updated = await (granting.get(value.pendingId) ?? value);
      if (updated.status === Status.Granting) await completeGrant(updated);
    }));
  }
  chromeApi.permissions.onAdded?.addListener(() => {
    void resumeGrants().catch(() => {});
  });
  return {
    handleExternalMessage, decide, current, consume, invalidateTab, refresh, resumeGrants,
    isOpeningPanel: tabId => [...provisional.values()].includes(tabId),
  };
}
