import { WebLaunchMethod } from '../../contracts/webLaunch.ts';
import { AppServerClient } from './conversation-client.js';
import { ensureAppServer } from './app-server-background.js';
import {
  WEB_RUNTIME,
  exactOrigin,
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
const SITES_KEY = 'chromeWebLaunchSites';
const scriptId = origin =>
  `web-launch-${[...new TextEncoder().encode(origin)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
const terminal = receipt =>
  receipt?.execution.executionSettled === true ||
  ['rejected', 'cancelled', 'expired'].includes(receipt?.request.status);

export function createWebLaunchBackground({
  chromeApi = chrome,
  cryptoApi = crypto,
  client: injectedClient,
} = {}) {
  const documents = new Map();
  const panels = new Map();
  const slots = new Map();
  const cancelled = new Set();
  const preparing = new Set();
  const retirements = new Map();
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
        const record = await transaction(() =>
          structuredClone(
            Object.values(state.requests).find(item => item.launchId === response.receipt.launchId),
          ),
        );
        if (!record) continue;
        record.response = {
          receipt: publicReceipt(response.receipt, false),
          internal: response.internal,
        };
        await transaction(() => {
          if (response.receipt.request.status === 'submitted' || terminal(response.receipt))
            delete record.input;
          state.requests[record.requestId] = record;
        });
        if (terminal(response.receipt)) slots.delete(record.source.windowId);
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
      if (previous && previous.enabled !== current?.enabled) void retireClient(doc).catch(() => {});
      if (!current?.enabled) doc.revoked = true;
    }
  }
  async function readSites() {
    const value = await client.request(WebLaunchMethod.SitesRead);
    applySites(value);
    return value;
  }
  async function getDocument(message, sender) {
    return transaction(async () => {
      const key = `${sender.tab.id}/${sender.documentId}/${message.documentNonce}`;
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
          documentNonce: message.documentNonce,
          deliveryRevision: 0,
          revoked: prior?.revoked === true,
          documentLeaseId: prior?.documentLeaseId ?? message.documentLeaseId,
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
      if (
        message.documentLeaseId &&
        doc.documentLeaseId &&
        message.documentLeaseId !== doc.documentLeaseId
      )
        throw { code: 'LEASE_REVOKED' };
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
  async function retireClient(doc) {
    await chromeApi.tabs.sendMessage(
      doc.source.tabId,
      { type: `${WEB_RUNTIME}retire`, documentNonce: doc.documentNonce },
      { documentId: doc.source.documentId },
    );
  }
  function envelope(record) {
    const { response, input } = record;
    if (!response?.internal) return null;
    const metadata = response.internal;
    return {
      launchId: response.receipt.launchId,
      requestId: record.requestId,
      origin: record.source.origin,
      threadId: metadata.threadId,
      mode: record.mode ?? input?.mode ?? 'draft',
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
      restored: Boolean(
        record.presentedPanelId &&
        record.presentedPanelId !== panels.get(record.source.windowId)?.id,
      ),
    };
  }
  function notifyPanel(record) {
    const panel = panels.get(record.source.windowId);
    if (!panel) return;
    void chromeApi.runtime
      .sendMessage({
        type: 'web-launch:panel:event',
        panelInstanceId: panel.id,
        windowId: record.source.windowId,
        envelope: ['cancelled', 'expired', 'rejected'].includes(
          record.response?.receipt.request.status,
        )
          ? undefined
          : envelope(record),
        receipt: record.response?.receipt,
        internal: record.response?.internal,
      })
      .catch(() => {});
  }
  async function accept(record, response, doc) {
    if (!response?.receipt || !response.internal) throw { code: 'CONNECTION_UNAVAILABLE' };
    record.response = response;
    record.launchId = response.receipt.launchId;
    doc.documentLeaseId = response.internal.documentLeaseId;
    record.documentLeaseId = doc.documentLeaseId;
    await transaction(() => {
      const saved = {
        ...record,
        response: {
          receipt: publicReceipt(response.receipt, false),
          internal: response.internal,
        },
      };
      if (response.receipt.request.status === 'submitted' || terminal(response.receipt))
        delete saved.input;
      state.requests[record.requestId] = saved;
      state.documents[doc.key] = {
        source: doc.source,
        documentLeaseId: doc.documentLeaseId,
        revoked: doc.revoked,
      };
    });
    if (terminal(response.receipt)) slots.delete(record.source.windowId);
    if (
      !cancelled.has(`${record.source.documentId}/${record.documentNonce}/${record.requestId}`) ||
      terminal(response.receipt)
    )
      notifyPanel(record);
    return response;
  }
  async function safeResponse(record, response, doc, revision) {
    const active = await documentActive(doc);
    if (!active || doc.revoked || doc.deliveryRevision !== revision)
      return { ok: false, code: 'LEASE_REVOKED' };
    const receipt = publicReceipt(response.receipt, record.result === 'final');
    if (!receipt || receipt.requestId !== record.requestId || receipt.launchId !== record.launchId)
      throw { code: 'INVALID_REQUEST' };
    return { ok: true, receipt, documentLeaseId: doc.documentLeaseId };
  }
  async function recoverDocument(record) {
    return getDocument(
      { documentNonce: record.documentNonce, documentLeaseId: record.documentLeaseId },
      {
        ...record.source,
        tab: { id: record.source.tabId, windowId: record.source.windowId },
        url: record.source.url,
      },
    );
  }
  async function prepare(message, sender, opened) {
    await opened;
    await retirements.get(sender.tab.id);
    const doc = await getDocument(message, sender);
    await readSites();
    const policy = sites.sites.find(site => site.origin === doc.source.origin);
    if (!policy?.enabled || doc.revoked || !(await documentActive(doc)))
      throw { code: 'SITE_NOT_ALLOWED' };
    if (cancelled.has(cancelKey(message, sender))) throw { code: 'EXPIRED' };
    const panel = panels.get(sender.tab.windowId) ?? state.panels[String(sender.tab.windowId)];
    if (panel?.busy) throw { code: 'COMPOSER_BUSY' };
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
      response = await client.request(WebLaunchMethod.Prepare, {
        source: doc.source,
        documentLeaseId: doc.documentLeaseId,
        requestId: message.requestId,
        bindingRevision: message.bindingRevision,
        clickSequence: message.clickSequence,
        payloadDigest: message.payloadDigest,
        input,
      });
    } catch (error) {
      error.prepareUncertain = error.requestSent === true;
      throw error;
    }
    if (doc.revoked || !(await documentActive(doc))) {
      doc.documentLeaseId = response.internal.documentLeaseId;
      await revoke(doc, 'navigation');
      throw { code: 'LEASE_REVOKED' };
    }
    if (cancelled.has(cancelKey(message, sender))) {
      response = await client.request(WebLaunchMethod.Cancel, {
        source: doc.source,
        documentLeaseId: response.internal.documentLeaseId,
        launchId: response.receipt.launchId,
      });
    }
    await accept(record, response, doc);
    return safeResponse(record, response, doc, revision);
  }
  async function observe(message, sender) {
    if (preparing.has(cancelKey(message, sender)) && !message.type.endsWith('cancel'))
      return { ok: true, pending: true };
    const doc = await getDocument(message, sender);
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
      documentLeaseId: doc.documentLeaseId,
      ...(record.launchId ? { launchId: record.launchId } : { requestId: record.requestId }),
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
    await accept(record, response, doc);
    return safeResponse(record, response, doc, revision);
  }
  async function revoke(doc, reason) {
    doc.revoked = true;
    doc.deliveryRevision += 1;
    await saveDocument(doc);
    if (doc.documentLeaseId)
      await client.request(WebLaunchMethod.RevokeDocument, {
        source: doc.source,
        documentLeaseId: doc.documentLeaseId,
        reason,
      });
    doc.revokeAcknowledged = true;
    await transaction(() => {
      if (state.documents[doc.key]) state.documents[doc.key].revokeAcknowledged = true;
    });
  }
  async function registerScripts(value) {
    const old = await chromeApi.scripting.getRegisteredContentScripts();
    const owned = old.filter(item => item.id.startsWith('web-launch-')).map(item => item.id);
    if (owned.length) await chromeApi.scripting.unregisterContentScripts({ ids: owned });
    const enabled = new Map();
    for (const site of value.sites) {
      if (!site.enabled) continue;
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
    await chromeApi.storage.local.set({
      [SITES_KEY]: value.sites.filter(site => site.enabled).map(site => site.origin),
    });
  }
  async function trustedMessage(message) {
    if (message.type === 'web-launch:panel:register') {
      const panel = {
        id: message.panelInstanceId,
        busy: message.composerBusy === true,
        windowId: message.windowId,
      };
      if (!validIdentifier(panel.id) || !Number.isSafeInteger(panel.windowId))
        throw { code: 'INVALID_REQUEST' };
      if (!panels.has(panel.windowId) && panels.size >= 128) throw { code: 'CAPACITY_EXCEEDED' };
      panels.set(panel.windowId, panel);
      await transaction(() => {
        state.panels[String(panel.windowId)] = panel;
      });
      const records = await transaction(() =>
        Object.values(state.requests).filter(record => record.source.windowId === panel.windowId),
      );
      const active = records.find(record => !terminal(record.response?.receipt));
      return {
        ok: true,
        envelope: active ? envelope(active) : undefined,
        observations: records.map(record => record.response).filter(Boolean),
      };
    }
    if (message.type === 'web-launch:panel:state') {
      const panel = panels.get(message.windowId);
      if (panel?.id !== message.panelInstanceId) throw { code: 'FORBIDDEN' };
      panel.busy = message.composerBusy === true;
      await transaction(() => {
        state.panels[String(panel.windowId)] = panel;
        if (message.launchId) {
          const record = Object.values(state.requests).find(
            item => item.launchId === message.launchId && item.source.windowId === panel.windowId,
          );
          if (record) record.presentedPanelId = panel.id;
        }
      });
      void refreshObservations().catch(() => {});
      return { ok: true };
    }
    if (message.type === 'web-launch:sites:list') {
      const value = await readSites();
      await registerScripts(value);
      return { ok: true, policies: value.sites, sitesRevision: value.revision };
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
          slots.delete(record.source.windowId);
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
    if (message.type === 'web-launch:launch:stop') {
      if (!validIdentifier(message.launchId)) throw { code: 'INVALID_REQUEST' };
      return {
        ok: true,
        ...(await client.request(WebLaunchMethod.Stop, { launchId: message.launchId })),
      };
    }
    const methods = {
      'web-launch:launch:submit': WebLaunchMethod.Submit,
      'web-launch:launch:revise': WebLaunchMethod.Revise,
      'web-launch:launch:cancel': WebLaunchMethod.Cancel,
      'web-launch:launch:stop': WebLaunchMethod.Stop,
      'web-launch:launch:abandon': WebLaunchMethod.Abandon,
    };
    const method = methods[message.type];
    if (!method) throw { code: 'INVALID_REQUEST' };
    const { type, panelInstanceId, windowId, reason, ...params } = message;
    const record = await transaction(() =>
      structuredClone(
        Object.values(state.requests).find(item => item.launchId === params.launchId),
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
    const response = await client.request(method, params);
    if (method === WebLaunchMethod.Revise && record.input) {
      record.input = {
        ...record.input,
        prompt: params.input.prompt,
        ...(params.input.context ? { context: { text: params.input.context.text } } : {}),
      };
      if (!params.input.context) delete record.input.context;
    }
    const doc = documents.get(record.documentKey);
    if (doc && response?.receipt) await accept(record, response, doc);
    return { ok: true, ...response, envelope: envelope(record) };
  }
  function handleMessage(message, sender, reply) {
    if (typeof message?.type !== 'string' || !message.type.startsWith('web-launch:')) return false;
    if (message.type === 'web-launch:panel:event') return false;
    const done = operation => {
      void operation.then(reply, error => reply({ ok: false, code: publicErrorCode(error) }));
      return true;
    };
    if (!message.type.startsWith(WEB_RUNTIME)) {
      if (!trustedExtensionPage(sender, chromeApi)) {
        reply({ ok: false, code: 'FORBIDDEN' });
        return false;
      }
      return done(trustedMessage(message));
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
        chromeApi.storage.local.get(SITES_KEY).then(value => ({
          ok: Array.isArray(value[SITES_KEY]) && value[SITES_KEY].includes(sender.origin),
          code: 'SITE_NOT_ALLOWED',
        })),
      );
    if (message.type === `${WEB_RUNTIME}digest`)
      return done(
        (async () => {
          const input = normalizeInput(message.input);
          const allowed = (await chromeApi.storage.local.get(SITES_KEY))[SITES_KEY];
          if (!input || !Array.isArray(allowed) || !allowed.includes(sender.origin))
            throw { code: 'SITE_NOT_ALLOWED' };
          return { ok: true, digest: await inputDigest(input, cryptoApi) };
        })(),
      );
    if (message.type === `${WEB_RUNTIME}launch`) {
      if (
        !validIdentifier(message.requestId) ||
        !Number.isSafeInteger(message.clickSequence) ||
        message.clickSequence < 1 ||
        !Number.isSafeInteger(message.bindingRevision) ||
        message.bindingRevision < 1 ||
        !/^[0-9a-f]{64}$/u.test(message.payloadDigest ?? '') ||
        !normalizeInput(message.input)
      ) {
        reply({ ok: false, code: 'INVALID_REQUEST' });
        return false;
      }
      if (slots.has(sender.tab.windowId)) {
        reply({ ok: false, code: 'WINDOW_BUSY' });
        return false;
      }
      slots.set(sender.tab.windowId, message.requestId);
      const pendingKey = cancelKey(message, sender);
      preparing.add(pendingKey);
      let opened;
      try {
        opened = chromeApi.sidePanel.open({ tabId: sender.tab.id });
      } catch (error) {
        slots.delete(sender.tab.windowId);
        preparing.delete(pendingKey);
        reply({ ok: false, code: 'FORBIDDEN' });
        return false;
      }
      return done(
        prepare(message, sender, opened)
          .catch(error => {
            if (!error.prepareUncertain) slots.delete(sender.tab.windowId);
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
  const invalidateTab = (tabId, soft = false) => {
    for (const doc of documents.values())
      if (doc.source.tabId === tabId) {
        doc.revoked = true;
        doc.deliveryRevision += 1;
      }
    const retiring = transaction(() => {
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
  chromeApi.tabs.onRemoved?.addListener(tabId => invalidateTab(tabId));
  chromeApi.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.status === 'loading' || change.url)
      invalidateTab(tabId, Boolean(change.url && change.status !== 'loading'));
  });
  chromeApi.windows?.onRemoved?.addListener(windowId => {
    panels.delete(windowId);
    slots.delete(windowId);
    void transaction(() => {
      delete state.windows[String(windowId)];
      delete state.panels[String(windowId)];
      return [
        ...new Set(
          Object.values(state.documents)
            .filter(value => value.source.windowId === windowId)
            .map(value => value.source.tabId),
        ),
      ];
    })
      .then(tabs => tabs.forEach(tabId => invalidateTab(tabId)))
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
          if (!allowed) return revoke(doc, 'permission-revoked');
        })
        .catch(() => {
          doc.permissionPending = false;
          void revoke(doc, 'permission-revoked').catch(() => {});
        });
    }
  });
  return { handleMessage, client };
}
