import { WebLaunchMethod, WebLaunchSendMode } from '../../contracts/webLaunch.ts';
import { AppServerClient } from './conversation-client.js';
import { ensureAppServer } from './app-server-background.js';
import { createWebLaunchConnections } from './web-launch-connections.js';
import { openTabSidePanel, tabIdFromSidePanelUrl } from './tab-side-panel.js';
import {
  WEB_RUNTIME,
  exactOrigin,
  hasWebsiteLaunchGrant,
  normalizeInput,
  inputDigest,
  publicErrorCode,
  publicReceipt,
  trustedExtensionPage,
  validDocumentSender,
  validDocumentIdentity,
  validIdentifier,
} from './web-launch-security.js';

const SESSION_KEY = 'chromeWebLaunchSession';
const SITES_KEY = 'chromeWebLaunchGrantedOrigins';
const LEGACY_SITES_KEY = 'chromeWebLaunchSites';
const LEGACY_SITE_READ_TIMEOUT_MS = 1000;
const grantedOriginsFrom = sites => sites.filter(hasWebsiteLaunchGrant).map(site => site.origin);
const scriptId = origin =>
  `web-launch-${[...new TextEncoder().encode(origin)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
const PANEL_SUBMIT_REQUEST = 'web-launch:launch:submit';

const terminal = receipt =>
  receipt?.execution.executionSettled === true ||
  ['rejected', 'cancelled', 'expired'].includes(receipt?.request.status);
const samePanelTab = (left, right) =>
  left?.tabId === right.tabId && left?.windowId === right.windowId;

export function createWebLaunchBackground({
  chromeApi = chrome,
  cryptoApi = crypto,
  client: injectedClient,
} = {}) {
  const documents = new Map();
  const panels = new Map();
  const slots = new Map();
  const restoredRequests = new Set();
  const cancelled = new Set();
  const preparing = new Set();
  const revising = new Map();
  const retirements = new Map();
  const releaseSlot = (windowId, requestId) => {
    if (slots.get(windowId) === requestId) slots.delete(windowId);
    restoredRequests.delete(requestId);
  };
  const cancelKey = (message, sender) =>
    `${sender.documentId}/${message.documentNonce}/${message.requestId}`;
  let state;
  let serial = Promise.resolve();
  let sites = { revision: -1, sites: [] };
  let observing;
  const client =
    injectedClient ??
    new AppServerClient(
      (method, params) => {
        if (method === 'chrome/webLaunch/sites/changed' && params?.sites) applySites(params);
        if (method === 'chrome/webLaunch/changed') {
          void readSites().catch(() => {});
          void refreshObservations().catch(() => {});
        }
      },
      {
        discover: async () => ({
          ok: true,
          ...(await ensureAppServer('browser-web-launch-background')),
        }),
        clientInfo: {
          name: 'browser-web-launch-background',
          title: 'Chrome conversation bridge',
          version: chromeApi.runtime.getManifest().version,
        },
      },
    );
  function transaction(action) {
    const next = serial.then(async () => {
      if (!state) {
        state = (await chromeApi.storage.session.get(SESSION_KEY))[SESSION_KEY] ?? {
          chromeInstanceId: cryptoApi.randomUUID(),
          windows: {},
          documents: {},
          requests: {},
          panels: {},
        };
        state.panels ??= {};
        state.channels ??= {};
        state.cancelled ??= {};
        for (const key of Object.keys(state.cancelled)) cancelled.add(key);
        // Anything recovered after a worker restart is an existing observation.
        for (const record of Object.values(state.requests))
          if (!terminal(record.response?.receipt)) restoredRequests.add(record.requestId);
      }
      const previous = structuredClone(state);
      try {
        const value = await action();
        collectMetadata();
        if (
          Object.keys(state.requests).length > 200 ||
          Object.keys(state.documents).length > 256 ||
          Object.keys(state.channels).length > 512 ||
          Object.keys(state.cancelled).length > 256 ||
          Object.keys(state.windows).length > 128 ||
          Object.keys(state.panels).length > 128 ||
          new TextEncoder().encode(JSON.stringify(state)).byteLength > 6 * 1024 * 1024
        )
          throw { code: 'CAPACITY_EXCEEDED' };
        await chromeApi.storage.session.set({ [SESSION_KEY]: state });
        return value;
      } catch (error) {
        state = previous;
        throw error;
      }
    });
    serial = next.catch(() => {});
    return next;
  }
  function collectMetadata() {
    const retired = Object.values(state.requests)
      .filter(record => terminal(record.response?.receipt))
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
    for (const record of retired.slice(0, Math.max(0, Object.keys(state.requests).length - 100)))
      delete state.requests[record.requestId];
    for (const [key, value] of Object.entries(state.documents)) {
      if (!value.revoked || !value.revokeAcknowledged) continue;
      if (
        Object.values(state.requests).some(
          record => record.documentKey === key && !terminal(record.response?.receipt),
        )
      )
        continue;
      delete state.documents[key];
      documents.delete(key);
    }
    const liveChannels = new Set(
      Object.values(state.documents).map(
        value => `${value.source.tabId}/${value.source.documentId}`,
      ),
    );
    for (const key of Object.keys(state.channels))
      if (!liveChannels.has(key)) delete state.channels[key];
    for (const key of Object.keys(state.cancelled)) {
      const requestId = key.split('/').at(-1);
      const record = state.requests[requestId];
      if (record && !terminal(record.response?.receipt)) continue;
      if ([...slots.values()].includes(requestId)) continue;
      delete state.cancelled[key];
      cancelled.delete(key);
    }
  }
  async function refreshObservations() {
    if (observing) return observing;
    observing = (async () => {
      const result = await client.request(WebLaunchMethod.Observations);
      const items = Array.isArray(result) ? result : (result?.observations ?? []);
      for (const response of items) {
        if (!response?.receipt || !response.internal) continue;
        const record = await transaction(() => {
          const current = state.requests[response.receipt.requestId];
          return current?.launchId === response.receipt.launchId
            ? cacheResponse(current, response)
            : undefined;
        });
        if (!record) continue;
        if (terminal(record.response.receipt))
          releaseSlot(record.source.windowId, record.requestId);
        notifyPanel(record);
      }
      return result;
    })().finally(() => {
      observing = undefined;
    });
    return observing;
  }
  function applySites(value) {
    if (
      !Array.isArray(value?.sites) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < sites.revision
    )
      return;
    const old = sites;
    sites = value;
    for (const doc of documents.values()) {
      const previous = old.sites.find(site => site.origin === doc.source.origin);
      const current = sites.sites.find(site => site.origin === doc.source.origin);
      if (previous?.revision !== current?.revision) doc.deliveryRevision += 1;
      if (!current?.enabled) {
        if (!doc.revoked) void retireClient(doc, true).catch(() => {});
        doc.revoked = true;
      } else if (previous && previous.enabled !== current.enabled)
        void retireClient(doc).catch(() => {});
    }
  }
  async function readSites() {
    const value = await client.request(WebLaunchMethod.SitesRead);
    applySites(value);
    return value;
  }
  async function hasCachedWebsiteGrant(origin) {
    const cached = (await chromeApi.storage.local.get(SITES_KEY))[SITES_KEY];
    if (Array.isArray(cached)) return cached.includes(origin);
    // Older caches include sites that only consented to opening drafts.
    const legacy = (await chromeApi.storage.local.get(LEGACY_SITES_KEY))[LEGACY_SITES_KEY];
    if (!Array.isArray(legacy) || !legacy.includes(origin)) return false;
    // The legacy lookup must leave time for the SDK to fall back to an inline connection.
    let timeout;
    const loaded = await Promise.race([
      readSites().then(
        () => true,
        () => false,
      ),
      new Promise(resolve => {
        timeout = setTimeout(() => resolve(false), LEGACY_SITE_READ_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!loaded) return false;
    const origins = grantedOriginsFrom(sites.sites);
    await chromeApi.storage.local.set({ [SITES_KEY]: origins });
    return origins.includes(origin);
  }
  async function getDocument(documentNonce, sender) {
    return transaction(async () => {
      const key = `${sender.tab.id}/${sender.documentId}/${documentNonce}`;
      let doc = documents.get(key);
      if (!doc) {
        if (documents.size >= 256) throw { code: 'CAPACITY_EXCEEDED' };
        const prior = state.documents[key];
        const windowKey = String(sender.tab.windowId);
        state.windows[windowKey] ??= cryptoApi.randomUUID();
        const channelKey = `${sender.tab.id}/${sender.documentId}`;
        const generation =
          Math.max(prior?.source.channelGeneration ?? 0, state.channels[channelKey] ?? 0) + 1;
        state.channels[channelKey] = generation;
        doc = {
          key,
          documentNonce,
          deliveryRevision: 0,
          revoked: prior?.revoked === true,
          documentLeaseId: prior?.documentLeaseId,
          source: {
            chromeInstanceId: state.chromeInstanceId,
            windowInstanceId: state.windows[windowKey],
            windowId: sender.tab.windowId,
            tabId: sender.tab.id,
            frameId: 0,
            documentId: sender.documentId,
            channelGeneration: generation,
            origin: sender.origin,
            url: sender.url,
            title: typeof sender.tab.title === 'string' ? sender.tab.title.slice(0, 500) : '',
          },
        };
        documents.set(key, doc);
      }
      state.documents[key] = {
        source: doc.source,
        documentLeaseId: doc.documentLeaseId,
        revoked: doc.revoked,
      };
      return doc;
    });
  }
  async function saveDocument(doc) {
    await transaction(() => {
      state.documents[doc.key] = {
        source: doc.source,
        documentLeaseId: doc.documentLeaseId,
        revoked: doc.revoked,
      };
    });
  }
  async function documentActive(doc) {
    if (doc.revoked || doc.permissionPending) return false;
    try {
      const origin = new URL(doc.source.origin);
      if (
        !(await chromeApi.permissions.contains({
          origins: [`${origin.protocol}//${origin.hostname}/*`],
        }))
      )
        return false;
      const target = await chromeApi.tabs.get(doc.source.tabId);
      if (exactOrigin(target.url) !== doc.source.origin || target.windowId !== doc.source.windowId)
        return false;
      const result = await chromeApi.tabs.sendMessage(
        doc.source.tabId,
        { type: `${WEB_RUNTIME}probe`, documentNonce: doc.documentNonce },
        { documentId: doc.source.documentId },
      );
      return result?.active === true && result.documentNonce === doc.documentNonce;
    } catch {
      return false;
    }
  }
  async function retireClient(doc, reconnectRequired = false) {
    await chromeApi.tabs.sendMessage(
      doc.source.tabId,
      { type: `${WEB_RUNTIME}retire`, documentNonce: doc.documentNonce, reconnectRequired },
      { documentId: doc.source.documentId },
    );
  }
  function panelFor(source) {
    const panel = panels.get(source.tabId);
    return samePanelTab(panel, source) ? panel : undefined;
  }
  function requestCancelled(record) {
    return cancelled.has(`${record.source.documentId}/${record.documentNonce}/${record.requestId}`);
  }
  function requestSourceAvailable(record) {
    const live = documents.get(record.documentKey);
    const saved = state.documents[record.documentKey];
    return Boolean(
      (live || saved) && !live?.revoked && !live?.permissionPending && !saved?.revoked,
    );
  }
  function envelope(record) {
    const { response, input } = record;
    if (
      !terminal(response?.receipt) &&
      (requestCancelled(record) || !requestSourceAvailable(record))
    )
      return null;
    // A restored composer must not revise from the snapshot an in-flight edit is replacing.
    if (!response?.internal || (input && revising.has(record.requestId))) return null;
    const metadata = response.internal;
    return {
      launchId: response.receipt.launchId,
      requestId: record.requestId,
      origin: record.source.origin,
      threadId: metadata.threadId,
      mode: metadata.effectiveMode ?? record.mode ?? input?.mode ?? WebLaunchSendMode.Draft,
      ...(metadata.permissionMode ? { permissionMode: metadata.permissionMode } : {}),
      result: record.result,
      prompt: input?.prompt ?? '',
      contextText: input?.context?.text,
      expiresAt: metadata.deadlineAt,
      deadlineAt: metadata.deadlineAt,
      automaticSendAllowed: !metadata.requiresSendConfirmation,
      shareAllowed: record.result === 'final' && !metadata.requiresResultConsent,
      requiresSendConfirmation: metadata.requiresSendConfirmation,
      requiresResultConsent: metadata.requiresResultConsent,
      requiresUnknownConfirmation: metadata.requiresUnknownConfirmation,
      composeRevision: metadata.composeRevision,
      receipt: response.receipt,
      restored:
        restoredRequests.has(record.requestId) ||
        Boolean(record.presentedPanelId && record.presentedPanelId !== panelFor(record.source)?.id),
    };
  }
  function panelEvent(source, fields) {
    const panel = panelFor(source);
    if (!panel) return;
    void chromeApi.runtime
      .sendMessage({
        type: 'web-launch:panel:event',
        panelInstanceId: panel.id,
        tabId: panel.tabId,
        windowId: panel.windowId,
        ...fields,
      })
      .catch(() => {});
  }
  function notifyPanel(record, { resume = false } = {}) {
    const receipt = record.response?.receipt;
    if (requestCancelled(record) && !terminal(receipt)) return;
    panelEvent(record.source, {
      envelope: ['cancelled', 'expired', 'rejected'].includes(
        record.response?.receipt.request.status,
      )
        ? undefined
        : envelope(record),
      receipt,
      internal: record.response?.internal,
      ...(resume ? { resume: true } : {}),
    });
  }
  function cacheResponse(record, response, revisedInput) {
    if (!response?.receipt || !response.internal) throw { code: 'CONNECTION_UNAVAILABLE' };
    const saved = { ...(state.requests[record.requestId] ?? record) };
    const receipt = publicReceipt(response.receipt, false);
    if (
      !receipt ||
      saved.documentKey !== record.documentKey ||
      receipt.requestId !== record.requestId ||
      (saved.launchId && saved.launchId !== receipt.launchId)
    )
      throw { code: 'INVALID_REQUEST' };
    const previous = saved.response;
    const composeRevision = response.internal.composeRevision;
    if (saved.input) saved.inputComposeRevision ??= previous?.internal.composeRevision ?? 1;
    if (
      !previous ||
      (receipt.receiptRevision >= previous.receipt.receiptRevision &&
        composeRevision >= previous.internal.composeRevision)
    ) {
      saved.response = { receipt, internal: response.internal };
      saved.launchId = receipt.launchId;
      saved.documentLeaseId = response.internal.documentLeaseId;
    }
    if (saved.input && revisedInput && composeRevision > saved.inputComposeRevision) {
      saved.input = {
        ...saved.input,
        prompt: revisedInput.prompt,
        ...(revisedInput.context ? { context: { text: revisedInput.context.text } } : {}),
      };
      if (!revisedInput.context) delete saved.input.context;
      saved.inputComposeRevision = composeRevision;
    }
    const accepted = saved.response.receipt;
    if (accepted.request.status === 'submitted' || terminal(accepted)) {
      delete saved.input;
      delete saved.inputComposeRevision;
    }
    state.requests[record.requestId] = saved;
    return saved;
  }
  async function accept(record, response, { doc, revisedInput } = {}) {
    const saved = await transaction(() => {
      if (doc?.revoked) return null;
      const updated = cacheResponse(record, response, revisedInput);
      // Only the preparation or its exact ACK recovery can establish a new lease.
      if (doc && !record.launchId && doc.documentLeaseId === record.documentLeaseId) {
        doc.documentLeaseId = updated.documentLeaseId;
        state.documents[doc.key] = {
          source: doc.source,
          documentLeaseId: doc.documentLeaseId,
          revoked: doc.revoked,
        };
      }
      return updated;
    });
    if (!saved) {
      if (!record.launchId) return discardPreparation(record, response, doc);
      throw { code: 'LEASE_REVOKED' };
    }
    const accepted = saved.response.receipt;
    if (terminal(accepted)) releaseSlot(saved.source.windowId, saved.requestId);
    notifyPanel(saved);
    return saved;
  }
  async function safeResponse(record, response, doc, revision) {
    const active = await documentActive(doc);
    if (
      !active ||
      doc.revoked ||
      doc.deliveryRevision !== revision ||
      doc.documentLeaseId !== response.internal.documentLeaseId
    )
      return { ok: false, code: 'LEASE_REVOKED' };
    const receipt = publicReceipt(response.receipt, record.result === 'final');
    if (!receipt || receipt.requestId !== record.requestId || receipt.launchId !== record.launchId)
      throw { code: 'INVALID_REQUEST' };
    return { ok: true, receipt };
  }
  async function recoverDocument(record) {
    return getDocument(record.documentNonce, {
      ...record.source,
      tab: { id: record.source.tabId, windowId: record.source.windowId },
      url: record.source.url,
    });
  }
  async function composerBusy(source) {
    const current = () => {
      const panel = panelFor(source) ?? state.panels[String(source.tabId)];
      return samePanelTab(panel, source) ? panel : undefined;
    };
    const registered = current();
    if (!registered?.busy) return false;
    const documentId = registered.documentId ?? registered.contextDocumentId;
    if (!documentId || !chromeApi.runtime.getContexts) return true;
    const contexts = await chromeApi.runtime
      .getContexts({
        contextTypes: ['SIDE_PANEL'],
        documentIds: [documentId],
      })
      .catch(() => null);
    const latest = current();
    return Boolean(
      latest?.busy &&
      (latest.id !== registered.id ||
        (latest.documentId ?? latest.contextDocumentId) !== documentId ||
        !contexts ||
        contexts.length > 0),
    );
  }
  async function prepare(message, sender, opened, admission = {}) {
    await opened;
    await retirements.get(sender.tab.id);
    const doc = await getDocument(message.documentNonce, sender);
    await readSites();
    const policy = sites.sites.find(site => site.origin === doc.source.origin);
    if (!hasWebsiteLaunchGrant(policy) || doc.revoked || !(await documentActive(doc)))
      throw { code: 'SITE_NOT_ALLOWED' };
    if (cancelled.has(cancelKey(message, sender))) throw { code: 'EXPIRED' };
    if (await composerBusy(doc.source)) throw { code: 'COMPOSER_BUSY' };
    const input = normalizeInput(message.input);
    const record = {
      requestId: message.requestId,
      createdAt: Date.now(),
      bindingRevision: message.bindingRevision,
      input,
      mode: input.mode,
      result: input.result,
      source: doc.source,
      documentNonce: doc.documentNonce,
      documentKey: doc.key,
      documentLeaseId: doc.documentLeaseId,
    };
    await transaction(() => {
      const pendingBytes = Object.values(state.requests).reduce(
        (total, item) =>
          total +
          (item.input ? new TextEncoder().encode(JSON.stringify(item.input)).byteLength : 0),
        0,
      );
      if (
        pendingBytes + new TextEncoder().encode(JSON.stringify(input)).byteLength >
        4 * 1024 * 1024
      )
        throw { code: 'CAPACITY_EXCEEDED' };
      state.requests[record.requestId] = structuredClone(record);
    });
    const revision = doc.deliveryRevision;
    let response;
    try {
      if (doc.revoked || doc.permissionPending) throw { code: 'LEASE_REVOKED' };
      if (cancelled.has(cancelKey(message, sender))) throw { code: 'EXPIRED' };
      // Main resolves a lease from the verified source of this new click.
      response = await client.request(WebLaunchMethod.Prepare, {
        source: doc.source,
        requestId: message.requestId,
        bindingRevision: message.bindingRevision,
        clickSequence: message.clickSequence,
        payloadDigest: message.payloadDigest,
        input,
        ...admission,
      });
    } catch (error) {
      const code = publicErrorCode(error);
      const prepareUncertain =
        error?.requestSent === true &&
        (error.responseReceived !== true || code === 'INTERNAL_ERROR');
      if (!prepareUncertain)
        await transaction(() => {
          delete state.requests[record.requestId];
        }).catch(() => {});
      throw { code, prepareUncertain };
    }
    try {
      if (!(await documentActive(doc)) || doc.revoked)
        return await discardPreparation(record, response, doc);
      if (cancelled.has(cancelKey(message, sender))) {
        response = await client.request(WebLaunchMethod.Cancel, {
          source: doc.source,
          documentLeaseId: response.internal.documentLeaseId,
          launchId: response.receipt.launchId,
        });
      }
      const saved = await accept(record, response, { doc });
      const projected = await safeResponse(saved, response, doc, revision);
      return projected.ok ? projected : { ...projected, prepareUncertain: true };
    } catch (error) {
      throw { code: publicErrorCode(error), prepareUncertain: error?.prepareUncertain !== false };
    }
  }
  async function observe(message, sender) {
    if (preparing.has(cancelKey(message, sender)) && !message.type.endsWith('cancel'))
      return { ok: true, pending: true };
    const doc = await getDocument(message.documentNonce, sender);
    let record = await transaction(() => structuredClone(state.requests[message.requestId]));
    if (!record && message.type.endsWith('cancel')) return { ok: true, pending: true };
    if (!record)
      record = {
        requestId: message.requestId,
        launchId: message.launchId,
        documentKey: doc.key,
        documentNonce: doc.documentNonce,
        source: doc.source,
        result: message.result === 'final' ? 'final' : 'none',
      };
    if (
      !record ||
      record.documentKey !== doc.key ||
      (message.launchId && message.launchId !== record.launchId)
    )
      throw { code: 'UNKNOWN_REQUEST' };
    await readSites();
    if (doc.revoked || !(await documentActive(doc))) throw { code: 'LEASE_REVOKED' };
    const revision = doc.deliveryRevision;
    const reference = {
      source: doc.source,
      ...(record.launchId
        ? { launchId: record.launchId, documentLeaseId: record.documentLeaseId }
        : { requestId: record.requestId }),
    };
    let response = await client.request(
      message.type.endsWith('cancel') ? WebLaunchMethod.Cancel : WebLaunchMethod.Read,
      reference,
    );
    if (!message.type.endsWith('cancel') && cancelled.has(cancelKey(message, sender))) {
      response = await client.request(WebLaunchMethod.Cancel, {
        source: doc.source,
        documentLeaseId: response.internal.documentLeaseId,
        launchId: response.receipt.launchId,
      });
    }
    const saved = await accept(record, response, { doc });
    return safeResponse(saved, response, doc, revision);
  }
  async function revoke(doc, reason, leaseId = doc.documentLeaseId) {
    doc.revoked = true;
    doc.deliveryRevision += 1;
    await saveDocument(doc);
    if (leaseId) {
      try {
        await client.request(WebLaunchMethod.RevokeDocument, {
          source: doc.source,
          documentLeaseId: leaseId,
          reason,
        });
      } catch (error) {
        // Expired and already revoked leases are no longer usable by this document channel.
        if (error?.code !== 'EXPIRED') throw error;
      }
    }
    doc.revokeAcknowledged = true;
    await transaction(() => {
      if (state.documents[doc.key]) state.documents[doc.key].revokeAcknowledged = true;
    });
  }
  async function discardPreparation(record, response, doc) {
    const leaseId = response.internal.documentLeaseId;
    if (doc.documentLeaseId === record.documentLeaseId) doc.documentLeaseId = leaseId;
    await revoke(doc, 'navigation', leaseId);
    await transaction(() => {
      delete state.requests[record.requestId];
    });
    releaseSlot(record.source.windowId, record.requestId);
    throw { code: 'LEASE_REVOKED', prepareUncertain: false };
  }
  async function registerScripts(value) {
    const old = await chromeApi.scripting.getRegisteredContentScripts();
    const owned = old.filter(item => item.id.startsWith('web-launch-')).map(item => item.id);
    if (owned.length) await chromeApi.scripting.unregisterContentScripts({ ids: owned });
    const enabled = new Map();
    for (const site of value.sites) {
      if (!hasWebsiteLaunchGrant(site)) continue;
      const url = new URL(site.origin);
      const match = `${url.protocol}//${url.hostname}/*`;
      if (await chromeApi.permissions.contains({ origins: [match] }))
        enabled.set(match, {
          id: scriptId(match),
          matches: [match],
          js: ['web-launch-content.js'],
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        });
    }
    if (enabled.size) await chromeApi.scripting.registerContentScripts([...enabled.values()]);
    await chromeApi.storage.local.set({ [SITES_KEY]: grantedOriginsFrom(value.sites) });
  }
  const connections = createWebLaunchConnections({
    chromeApi,
    cryptoApi,
    client,
    readSites,
    applySites,
    registerScripts,
    hasCachedWebsiteGrant,
    store: action => transaction(() => action((state.connections ??= {}))),
    windowBusy: windowId => slots.has(windowId),
    notify: (source, connectionPending) => panelEvent(source, { connectionPending }),
  });
  function panelTab(message, sender) {
    const tabId = tabIdFromSidePanelUrl(sender.url, chromeApi);
    if (
      tabId === null ||
      tabId !== message.tabId ||
      sender.tab ||
      !Number.isSafeInteger(message.windowId) ||
      !validIdentifier(message.panelInstanceId)
    )
      throw { code: 'FORBIDDEN' };
    return tabId;
  }
  function registeredPanel(message, sender) {
    const panel = panels.get(panelTab(message, sender));
    if (
      !samePanelTab(panel, message) ||
      panel.id !== message.panelInstanceId ||
      (panel.documentId && panel.documentId !== sender.documentId)
    )
      throw { code: 'FORBIDDEN' };
    return panel;
  }
  async function trustedMessage(message, sender) {
    if (message.type === 'web-launch:connection:decide') {
      registeredPanel(message, sender);
      return connections.decide(message);
    }
    if (message.type === 'web-launch:panel:register') {
      const panel = {
        tabId: panelTab(message, sender),
        id: message.panelInstanceId,
        ...(validIdentifier(sender.documentId) ? { documentId: sender.documentId } : {}),
        busy: message.composerBusy === true,
        windowId: message.windowId,
      };
      const records = await transaction(async () => {
        const tab = await chromeApi.tabs.get(panel.tabId).catch(() => null);
        if (tab?.windowId !== panel.windowId) throw { code: 'FORBIDDEN' };
        if (!panel.documentId && chromeApi.runtime.getContexts) {
          const contexts = await chromeApi.runtime
            .getContexts({
              contextTypes: ['SIDE_PANEL'],
              documentUrls: [sender.url],
            })
            .catch(() => []);
          if (contexts.length === 1 && validIdentifier(contexts[0].documentId))
            panel.contextDocumentId = contexts[0].documentId;
        }
        state.panels[String(panel.tabId)] = panel;
        return Object.values(state.requests).filter(record => samePanelTab(panel, record.source));
      });
      panels.set(panel.tabId, panel);
      const eligible = record =>
        !terminal(record.response?.receipt) &&
        !requestCancelled(record) &&
        requestSourceAvailable(record);
      const active =
        records.find(
          record => record.requestId === slots.get(panel.windowId) && eligible(record),
        ) ?? records.find(eligible);
      return {
        ok: true,
        envelope: active ? envelope(active) : undefined,
        observations: records.map(record => record.response).filter(Boolean),
        connectionPending: await connections.current(panel),
      };
    }
    if (message.type === 'web-launch:panel:state') {
      const panel = registeredPanel(message, sender);
      panel.busy = message.composerBusy === true;
      await transaction(() => {
        state.panels[String(panel.tabId)] = panel;
        if (message.launchId) {
          const record = Object.values(state.requests).find(
            item => item.launchId === message.launchId && samePanelTab(panel, item.source),
          );
          if (record) record.presentedPanelId = panel.id;
        }
      });
      void refreshObservations().catch(() => {});
      void connections.refresh(panel).catch(() => {});
      return { ok: true };
    }
    if (message.type === 'web-launch:sites:list') {
      const value = await readSites();
      await registerScripts(value);
      return {
        ok: true,
        policies: value.sites,
        sitesRevision: value.revision,
        sendMode: value.sendMode ?? WebLaunchSendMode.Website,
      };
    }
    if (message.type === 'web-launch:sites:send-mode') {
      const value = await client.request(WebLaunchMethod.SendModeSet, {
        expectedRevision: message.expectedRevision,
        sendMode: message.sendMode,
      });
      applySites(value);
      return { ok: true, sitesRevision: value.revision, sendMode: value.sendMode };
    }
    if (message.type === 'web-launch:sites:save') {
      const params = {
        expectedRevision: message.expectedRevision,
        origin: message.origin,
        enabled: message.enabled,
        allowSend: message.allowSend,
        allowResult: message.allowResult,
      };
      const value = await client.request(WebLaunchMethod.SitesWrite, params);
      const next = value?.sites ? value : await readSites();
      applySites(next);
      await registerScripts(next);
      return { ok: true, policies: next.sites, sitesRevision: next.revision };
    }
    if (message.type === 'web-launch:observations:list')
      return { ok: true, observations: await client.request(WebLaunchMethod.Observations) };
    if (message.type === 'web-launch:launch:abandon') {
      if (!validIdentifier(message.launchId) || message.confirm !== true)
        throw { code: 'INVALID_REQUEST' };
      if (new URL(sender.url).pathname !== '/options.html') {
        const panel = registeredPanel(message, sender);
        const owned = await transaction(() =>
          Object.values(state.requests).some(
            record => record.launchId === message.launchId && samePanelTab(panel, record.source),
          ),
        );
        if (!owned) throw { code: 'UNKNOWN_REQUEST' };
      }
      const result = await client.request(WebLaunchMethod.Abandon, {
        launchId: message.launchId,
        confirm: true,
      });
      const abandoned = await transaction(() =>
        Object.values(state.requests)
          .filter(record => record.launchId === message.launchId)
          .map(record => ({ source: record.source, documentNonce: record.documentNonce })),
      );
      await Promise.allSettled(abandoned.map(retireClient));
      await transaction(() => {
        for (const record of Object.values(state.requests)) {
          if (record.launchId !== message.launchId) continue;
          releaseSlot(record.source.windowId, record.requestId);
          delete state.requests[record.requestId];
          if (state.documents[record.documentKey])
            Object.assign(state.documents[record.documentKey], {
              revoked: true,
              revokeAcknowledged: true,
            });
          const doc = documents.get(record.documentKey);
          if (doc) {
            doc.revoked = true;
            doc.deliveryRevision += 1;
          }
        }
      });
      return { ok: true, ...result };
    }
    const methods = {
      [PANEL_SUBMIT_REQUEST]: WebLaunchMethod.Submit,
      'web-launch:launch:revise': WebLaunchMethod.Revise,
      'web-launch:launch:cancel': WebLaunchMethod.Cancel,
      'web-launch:launch:stop': WebLaunchMethod.Stop,
    };
    const method = methods[message.type];
    if (!method) throw { code: 'INVALID_REQUEST' };
    const panel = registeredPanel(message, sender);
    const { type, panelInstanceId, tabId, windowId, reason, ...params } = message;
    const record = await transaction(() =>
      structuredClone(
        Object.values(state.requests).find(
          item => item.launchId === params.launchId && samePanelTab(panel, item.source),
        ),
      ),
    );
    if (!record) throw { code: 'UNKNOWN_REQUEST' };
    if (method === WebLaunchMethod.Submit) {
      const document = await recoverDocument(record);
      if (!(await documentActive(document))) {
        await revoke(document, 'navigation').catch(() => {});
        throw { code: 'EXPIRED' };
      }
    }
    if ([WebLaunchMethod.Cancel].includes(method))
      Object.assign(params, { source: record.source, documentLeaseId: record.documentLeaseId });
    const isRevise = method === WebLaunchMethod.Revise;
    if (isRevise) revising.set(record.requestId, (revising.get(record.requestId) ?? 0) + 1);
    let response;
    let saved;
    try {
      response = await client.request(method, params);
      saved = response?.receipt
        ? await accept(record, response, { revisedInput: isRevise ? params.input : undefined })
        : record;
    } finally {
      if (isRevise) {
        const remaining = revising.get(record.requestId) - 1;
        if (remaining) revising.set(record.requestId, remaining);
        else {
          revising.delete(record.requestId);
          const current = await transaction(() => state.requests[record.requestId]).catch(
            () => null,
          );
          if (current?.response) notifyPanel(current);
        }
      }
    }
    return {
      ok: true,
      ...(response?.receipt ? saved.response : response),
      envelope: envelope(saved),
    };
  }
  function findReopenedRequest(requestId, message, sender) {
    if (requestId !== message.reopenRequestId) return undefined;
    const record = state?.requests[requestId];
    if (
      !record?.response?.receipt ||
      terminal(record.response.receipt) ||
      record.documentNonce !== message.documentNonce ||
      record.source.windowId !== sender.tab.windowId ||
      record.source.tabId !== sender.tab.id ||
      record.source.documentId !== sender.documentId ||
      record.source.origin !== sender.origin
    )
      return undefined;
    return record;
  }
  async function restoreOrPrepare(message, sender, opened) {
    if (!message.reopenRequestId) return prepare(message, sender, opened);
    // Consume a fast Chrome rejection while storage is loading the original owner.
    const didOpen = opened.then(
      () => true,
      () => false,
    );
    const { windowId } = sender.tab;
    const previous = await transaction(() =>
      findReopenedRequest(message.reopenRequestId, message, sender),
    );
    if (slots.get(windowId) !== message.requestId) throw { code: 'EXPIRED' };
    if (previous) {
      const record = findReopenedRequest(previous.requestId, message, sender);
      if (!record || requestCancelled(record) || !requestSourceAvailable(record))
        throw { code: 'EXPIRED' };
      slots.set(windowId, record.requestId);
      restoredRequests.add(record.requestId);
      return reopenExisting(
        record,
        didOpen.then(ok => {
          if (!ok) throw { code: 'PANEL_OPEN_FAILED' };
        }),
      );
    }
    if (!(await didOpen)) throw { code: 'PANEL_OPEN_FAILED' };
    return prepare(message, sender, Promise.resolve());
  }
  async function reopenExisting(record, opened) {
    try {
      await opened;
    } catch {
      throw { code: 'PANEL_OPEN_FAILED' };
    }
    const current = state.requests[record.requestId];
    if (
      current?.launchId === record.launchId &&
      current.documentKey === record.documentKey &&
      slots.get(record.source.windowId) === record.requestId &&
      !terminal(current.response?.receipt) &&
      !requestCancelled(current) &&
      requestSourceAvailable(current)
    )
      notifyPanel(current, { resume: true });
    return { ok: true, reopened: true };
  }
  function handleMessage(message, sender, reply) {
    if (typeof message?.type !== 'string' || !message.type.startsWith('web-launch:')) return false;
    if (message.type === 'web-launch:panel:event') return false;
    const done = operation => {
      void operation.then(reply, error =>
        reply({
          ok: false,
          code: publicErrorCode(error),
          ...(error?.prepareUncertain === true ? { prepareUncertain: true } : {}),
          ...(message.type === PANEL_SUBMIT_REQUEST && error?.requestSent === false
            ? { requestSent: false }
            : {}),
        }),
      );
      return true;
    };
    if (!message.type.startsWith(WEB_RUNTIME)) {
      if (!trustedExtensionPage(sender, chromeApi)) {
        reply({ ok: false, code: 'FORBIDDEN' });
        return false;
      }
      return done(trustedMessage(message, sender));
    }
    if (message.type === `${WEB_RUNTIME}revoke`) {
      if (!validDocumentIdentity(sender, chromeApi) || !validIdentifier(message.documentNonce)) {
        reply({ ok: false, code: 'FORBIDDEN' });
        return false;
      }
      return done(
        transaction(() => {
          const key = `${sender.tab.id}/${sender.documentId}/${message.documentNonce}`;
          const saved = state.documents[key];
          if (!saved || saved.source.origin !== sender.origin) throw { code: 'EXPIRED' };
          return (
            documents.get(key) ?? {
              ...saved,
              key,
              documentNonce: message.documentNonce,
              deliveryRevision: 0,
            }
          );
        })
          .then(doc => revoke(doc, message.reason === 'pagehide' ? 'pagehide' : 'navigation'))
          .then(() => ({ ok: true })),
      );
    }
    if (!validDocumentSender(sender, chromeApi) || !validIdentifier(message.documentNonce)) {
      reply({ ok: false, code: 'FORBIDDEN' });
      return false;
    }
    if (message.type === `${WEB_RUNTIME}hello`)
      return done(
        hasCachedWebsiteGrant(sender.origin).then(ok => ({
          ok,
          code: 'SITE_NOT_ALLOWED',
        })),
      );
    if (message.type === `${WEB_RUNTIME}digest`)
      return done(
        (async () => {
          const input = normalizeInput(message.input);
          if (!input || !(await hasCachedWebsiteGrant(sender.origin)))
            throw { code: 'SITE_NOT_ALLOWED' };
          return { ok: true, digest: await inputDigest(input, cryptoApi) };
        })(),
      );
    if ([`${WEB_RUNTIME}launch`, `${WEB_RUNTIME}connection-launch`].includes(message.type)) {
      const continuation = message.type === `${WEB_RUNTIME}connection-launch`;
      if (
        !validIdentifier(message.requestId) ||
        !Number.isSafeInteger(message.clickSequence) ||
        message.clickSequence < 1 ||
        !Number.isSafeInteger(message.bindingRevision) ||
        message.bindingRevision < 1 ||
        !/^[0-9a-f]{64}$/u.test(message.payloadDigest ?? '') ||
        !normalizeInput(message.input) ||
        (message.reopenRequestId !== undefined &&
          (continuation || !validIdentifier(message.reopenRequestId))) ||
        (continuation &&
          (!validIdentifier(message.pendingId) || !validIdentifier(message.bindingId)))
      ) {
        reply({ ok: false, code: 'INVALID_REQUEST' });
        return false;
      }
      const existing = slots.get(sender.tab.windowId);
      if (existing) {
        const record = !continuation && findReopenedRequest(existing, message, sender);
        if (!record || requestCancelled(record) || !requestSourceAvailable(record)) {
          reply({ ok: false, code: 'WINDOW_BUSY' });
          return false;
        }
        // Install the restored envelope before Chrome can create the replacement side panel.
        restoredRequests.add(existing);
        return done(reopenExisting(record, openTabSidePanel(chromeApi, sender.tab.id)));
      }
      slots.set(sender.tab.windowId, message.requestId);
      const pendingKey = cancelKey(message, sender);
      preparing.add(pendingKey);
      if (continuation)
        return done(
          connections
            .consume(message, sender)
            .then(admission => prepare(message, sender, Promise.resolve(), admission))
            .catch(error => {
              if (!error.prepareUncertain) releaseSlot(sender.tab.windowId, message.requestId);
              throw error;
            })
            .finally(() => preparing.delete(pendingKey)),
        );
      let opened;
      try {
        opened = openTabSidePanel(chromeApi, sender.tab.id);
      } catch (error) {
        releaseSlot(sender.tab.windowId, message.requestId);
        preparing.delete(pendingKey);
        reply({ ok: false, code: 'FORBIDDEN' });
        return false;
      }
      return done(
        restoreOrPrepare(message, sender, opened)
          .catch(error => {
            if (!error.prepareUncertain) releaseSlot(sender.tab.windowId, message.requestId);
            throw error;
          })
          .finally(() => preparing.delete(pendingKey)),
      );
    }
    if (message.type === `${WEB_RUNTIME}cancel` && validIdentifier(message.requestId)) {
      const key = cancelKey(message, sender);
      if (cancelled.size >= 256 && !cancelled.has(key)) {
        reply({ ok: false, code: 'CAPACITY_EXCEEDED' });
        return false;
      }
      cancelled.add(key);
      void transaction(() => {
        state.cancelled[key] = true;
      });
    }
    if ([`${WEB_RUNTIME}read`, `${WEB_RUNTIME}cancel`].includes(message.type))
      return done(observe(message, sender));
    reply({ ok: false, code: 'INVALID_REQUEST' });
    return false;
  }
  const invalidateTab = (tabId, { soft = false, removePanel = false } = {}) => {
    connections.invalidateTab(tabId);
    if (removePanel) panels.delete(tabId);
    for (const doc of documents.values())
      if (doc.source.tabId === tabId) {
        doc.revoked = true;
        doc.deliveryRevision += 1;
      }
    const retiring = transaction(() => {
      if (removePanel) {
        panels.delete(tabId);
        delete state.panels[String(tabId)];
      }
      return Object.entries(state.documents)
        .filter(([, value]) => value.source.tabId === tabId)
        .map(([key, value]) => {
          value.revoked = true;
          return (
            documents.get(key) ?? {
              ...value,
              key,
              documentNonce: key.split('/').at(-1),
              deliveryRevision: 1,
              revoked: true,
            }
          );
        });
    }).then(async values => {
      if (soft) await Promise.allSettled(values.map(retireClient));
      await Promise.all(values.map(doc => revoke(doc, 'navigation')));
      await refreshObservations();
    });
    retirements.set(tabId, retiring);
    void retiring
      .finally(() => {
        if (retirements.get(tabId) === retiring) retirements.delete(tabId);
      })
      .catch(() => {});
  };
  chromeApi.tabs.onRemoved?.addListener(tabId => invalidateTab(tabId, { removePanel: true }));
  chromeApi.tabs.onDetached?.addListener(tabId =>
    invalidateTab(tabId, { soft: true, removePanel: true }),
  );
  chromeApi.tabs.onReplaced?.addListener((_addedTabId, removedTabId) =>
    invalidateTab(removedTabId, { removePanel: true }),
  );
  chromeApi.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.status === 'loading' || change.url)
      invalidateTab(tabId, { soft: Boolean(change.url && change.status !== 'loading') });
  });
  chromeApi.windows?.onRemoved?.addListener(windowId => {
    for (const panel of panels.values())
      if (panel.windowId === windowId) panels.delete(panel.tabId);
    releaseSlot(windowId, slots.get(windowId));
    void transaction(() => {
      delete state.windows[String(windowId)];
      for (const [key, panel] of Object.entries(state.panels))
        if (panel.windowId === windowId) delete state.panels[key];
      return [
        ...new Set(
          Object.values(state.documents)
            .filter(value => value.source.windowId === windowId)
            .map(value => value.source.tabId),
        ),
      ];
    })
      .then(tabs =>
        Promise.all(
          tabs.map(async tabId => {
            const tab = await chromeApi.tabs.get(tabId).catch(() => null);
            if (!tab || tab.windowId === windowId) invalidateTab(tabId, { removePanel: true });
          }),
        ),
      )
      .catch(() => {});
  });
  chromeApi.permissions.onRemoved?.addListener(() => {
    for (const doc of documents.values()) {
      doc.deliveryRevision += 1;
      doc.permissionPending = true;
      const url = new URL(doc.source.origin);
      void chromeApi.permissions
        .contains({ origins: [`${url.protocol}//${url.hostname}/*`] })
        .then(allowed => {
          doc.permissionPending = false;
          if (!allowed)
            return retireClient(doc, true)
              .catch(() => {})
              .then(() => revoke(doc, 'permission-revoked'));
        })
        .catch(() => {
          doc.permissionPending = false;
          void revoke(doc, 'permission-revoked').catch(() => {});
        });
    }
  });
  return { handleMessage, handleExternalMessage: connections.handleExternalMessage, client };
}
