import { WebLaunchMethod } from '../../contracts/webLaunch.ts';
import {
  WEB_CONNECTION,
  WEB_RUNTIME,
  exactOrigin,
  inputDigest,
  normalizeInput,
  publicErrorCode,
  validExternalDocumentSender,
  validIdentifier,
} from './web-launch-security.js';

const LIFETIME = 120_000;
const Status = Object.freeze({
  Awaiting: 'awaiting-consent',
  Granting: 'granting',
  Connected: 'connected',
  Rejected: 'rejected',
  Cancelled: 'cancelled',
  Expired: 'expired',
});
const live = value =>
  [Status.Awaiting, Status.Granting, Status.Connected].includes(value.status) && !value.claimed;
const sameSource = (value, sender) =>
  value.source.origin === sender.origin &&
  value.source.documentId === sender.documentId &&
  value.source.tabId === sender.tab.id &&
  value.source.windowId === sender.tab.windowId;
const metadata = value =>
  value
    ? {
        pendingId: value.pendingId,
        revision: value.revision,
        origin: value.source.origin,
        expiresAt: value.expiresAt,
        status: value.status,
        requiresAction: value.requiresAction === true,
        ...(value.code ? { code: value.code } : {}),
      }
    : null;

/** Untrusted external messages can request a connection, never a native operation. */
export function createWebLaunchConnections({
  chromeApi,
  cryptoApi,
  store,
  client,
  readSites,
  applySites,
  registerScripts,
  notify,
  windowBusy,
  now = () => Date.now(),
}) {
  const provisional = new Set();
  const tabEpoch = new Map();
  const retired = new Set();
  const refreshes = new Map();
  const expired = value => value.expiresAt <= now();
  const retire = id => {
    retired.add(id);
    if (retired.size > 128) retired.delete(retired.values().next().value);
  };
  function collect(values) {
    for (const value of Object.values(values)) {
      if (live(value) && expired(value)) {
        value.status = Status.Expired;
        value.revision += 1;
        value.requiresAction = false;
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
    const result = await store(values => {
      collect(values);
      const value = values[pendingId];
      if (!value) throw { code: 'EXPIRED' };
      action(value);
      return structuredClone(value);
    });
    notify(result.source.windowId, metadata(result));
    return result;
  }
  async function current(windowId) {
    return store(values => {
      collect(values);
      const value = Object.values(values)
        .reverse()
        .filter(item => item.source.windowId === windowId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return metadata(value);
    });
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
  async function assertGrant(value) {
    return store(values => {
      collect(values);
      const current = values[value.pendingId];
      if (!current || current.status !== Status.Granting || current.revision !== value.revision)
        throw { code: 'EXPIRED' };
      return structuredClone(current);
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
  async function refresh(windowId) {
    const prior = refreshes.get(windowId);
    if (prior && now() - prior.at < 5000) return;
    refreshes.set(windowId, { at: now() });
    if (refreshes.size > 128) refreshes.delete(refreshes.keys().next().value);
    const value = await store(values =>
      structuredClone(
        Object.values(values).find(
          item =>
            item.source.windowId === windowId &&
            item.status === Status.Awaiting &&
            item.sitesRevision === undefined &&
            !expired(item),
        ),
      ),
    );
    if (!value) return;
    try {
      const policies = await readSites();
      await change(value.pendingId, item => {
        if (item.status !== Status.Awaiting || item.sitesRevision !== undefined) return;
        item.sitesRevision = policies.revision;
        item.requiresAction = true;
        item.revision += 1;
        delete item.code;
      });
    } catch {
      /* The trusted panel heartbeat can retry discovery without granting anything. */
    }
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
            'windowId',
          ].includes(key),
      )
    )
      throw { code: 'INVALID_REQUEST' };
    let value = await change(message.pendingId, item => {
      if (item.source.windowId !== message.windowId) throw { code: 'FORBIDDEN' };
      if (message.decision === 'deny') {
        if (item.claimed) throw { code: 'TOO_LATE' };
        if (message.expectedRevision > item.revision || !live(item)) throw { code: 'EXPIRED' };
      } else if (
        item.revision !== message.expectedRevision ||
        ![Status.Awaiting, Status.Granting].includes(item.status)
      )
        throw { code: 'EXPIRED' };
      if (message.decision === 'allow' && (item.status !== Status.Awaiting || !item.requiresAction))
        throw { code: 'EXPIRED' };
      item.status = message.decision === 'deny' ? Status.Rejected : Status.Granting;
      item.requiresAction = false;
      item.revision += 1;
      if (message.decision === 'deny') {
        retire(item.pendingId);
        item.code =
          message.reason === 'permission-denied' ? 'PERMISSION_REQUIRED' : 'CONNECTION_REJECTED';
        delete item.input;
      }
    });
    if (message.decision === 'deny') return { ok: true, connectionPending: metadata(value) };
    try {
      const origin = new URL(value.source.origin);
      if (
        !(await chromeApi.permissions.contains({
          origins: [`${origin.protocol}//${origin.hostname}/*`],
        }))
      )
        throw { code: 'PERMISSION_REQUIRED' };
      await sourceActive(value);
      await assertGrant(value);
      let policies = await readSites();
      await assertGrant(value);
      assertLive(value);
      if (policies.revision !== value.sitesRevision) throw { code: 'POLICY_CONFLICT' };
      const existing = policies.sites.find(
        site => site.origin === value.source.origin && site.enabled,
      );
      if (!existing) {
        policies = await client.request(WebLaunchMethod.SitesWrite, {
          expectedRevision: value.sitesRevision,
          origin: value.source.origin,
          enabled: true,
          allowSend: false,
          allowResult: false,
        });
        if (!Array.isArray(policies?.sites)) throw { code: 'CONNECTION_UNAVAILABLE' };
        applySites(policies);
      }
      await assertGrant(value);
      await registerScripts(policies);
      await sourceActive(value);
      await assertGrant(value);
      await chromeApi.scripting.executeScript({
        target: { tabId: value.source.tabId, documentIds: [value.source.documentId] },
        files: ['web-launch-content.js'],
      });
      await assertGrant(value);
      value = await change(value.pendingId, item => {
        if (item.status !== Status.Granting || item.revision !== value.revision)
          throw { code: 'EXPIRED' };
        item.status = Status.Connected;
        item.policyRevision = policies.revision;
        item.revision += 1;
      });
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
      return { ok: true, connectionPending: metadata(value) };
    } catch (error) {
      await change(value.pendingId, item => {
        if (![Status.Granting, Status.Connected].includes(item.status) || item.claimed) return;
        item.status = Status.Expired;
        item.code = publicErrorCode(error);
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
      request: ['bindingId', 'bindingRevision', 'payloadDigest', 'input'],
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
      void operation.then(reply, error => reply({ ok: false, code: publicErrorCode(error) }));
      return true;
    };
    if (message.op === 'probe')
      return done(
        (async () => {
          const origins = (await chromeApi.storage.local.get('chromeWebLaunchSites'))
            .chromeWebLaunchSites;
          const origin = new URL(sender.origin);
          const connected =
            Array.isArray(origins) &&
            origins.includes(sender.origin) &&
            (await chromeApi.permissions.contains({
              origins: [`${origin.protocol}//${origin.hostname}/*`],
            }));
          return { ok: true, connected: Boolean(connected) };
        })(),
      );
    if (message.op === 'query')
      return done(
        find(message, sender).then(value => ({ ok: true, connectionPending: metadata(value) })),
      );
    if (message.op === 'cancel')
      return done(
        find(message, sender)
          .then(value =>
            change(value.pendingId, item => {
              if (item.claimed) throw { code: 'TOO_LATE' };
              retire(item.pendingId);
              item.status = Status.Cancelled;
              item.requiresAction = false;
              item.revision += 1;
              delete item.input;
            }),
          )
          .then(value => ({ ok: true, connectionPending: metadata(value) })),
      );
    const input = normalizeInput(message.input);
    if (
      !input ||
      !Number.isSafeInteger(message.bindingRevision) ||
      message.bindingRevision < 1 ||
      !/^[a-f0-9]{64}$/u.test(message.payloadDigest ?? '')
    ) {
      reply({ ok: false, code: 'INVALID_REQUEST' });
      return false;
    }
    if (provisional.has(sender.tab.windowId) || windowBusy(sender.tab.windowId)) {
      reply({ ok: false, code: 'WINDOW_BUSY' });
      return false;
    }
    provisional.add(sender.tab.windowId);
    const epoch = tabEpoch.get(sender.tab.id) ?? 0;
    let opened;
    try {
      opened = chromeApi.sidePanel.open({ tabId: sender.tab.id });
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
              item => item.source.windowId === sender.tab.windowId && live(item),
            );
            if (existing) {
              if (
                !sameSource(existing, sender) ||
                existing.bindingId !== message.bindingId ||
                existing.bindingRevision !== message.bindingRevision ||
                existing.payloadDigest !== message.payloadDigest
              )
                throw { code: 'WINDOW_BUSY' };
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
              status: Status.Awaiting,
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
          if ((tabEpoch.get(sender.tab.id) ?? 0) !== epoch) throw { code: 'EXPIRED' };
          notify(value.source.windowId, metadata(value));
          if (value.status === Status.Awaiting && value.sitesRevision === undefined) {
            try {
              const policies = await readSites();
              value = await change(value.pendingId, item => {
                if (item.status !== Status.Awaiting) return;
                item.sitesRevision = policies.revision;
                item.requiresAction = true;
                item.revision += 1;
              });
            } catch (error) {
              value = await change(value.pendingId, item => {
                item.code = publicErrorCode(error);
              });
            }
          }
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
    notify(value.source.windowId, metadata(value));
    return { connectionOnly: true, expectedPolicyRevision: value.policyRevision };
  }
  function invalidateTab(tabId) {
    tabEpoch.set(tabId, (tabEpoch.get(tabId) ?? 0) + 1);
    if (tabEpoch.size > 256) tabEpoch.delete(tabEpoch.keys().next().value);
    void store(values => {
      const windows = [];
      for (const value of Object.values(values))
        if (value.source.tabId === tabId && live(value)) {
          retire(value.pendingId);
          value.status = Status.Expired;
          value.revision += 1;
          value.requiresAction = false;
          delete value.input;
          windows.push(value.source.windowId);
        }
      return windows;
    })
      .then(windows =>
        Promise.all(windows.map(async windowId => notify(windowId, await current(windowId)))),
      )
      .catch(() => {});
  }
  return { handleExternalMessage, decide, current, consume, invalidateTab, refresh };
}
