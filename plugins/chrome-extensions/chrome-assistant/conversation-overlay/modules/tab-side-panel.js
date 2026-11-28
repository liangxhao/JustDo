export const GLOBAL_SIDE_PANEL_PATH = 'sidepanel.html';
export const PANEL_SCOPE_PREFERENCE = 'sidePanelScopePreference';
export const SidePanelMessage = Object.freeze({
  SwitchScope: 'side-panel:switch-scope',
  TakeContinuation: 'side-panel:take-continuation',
  WaitFollowSwitch: 'side-panel:wait-follow-switch',
  CancelFollowSwitch: 'side-panel:cancel-follow-switch',
  ReserveCachedGlobal: 'side-panel:reserve-cached-global',
  ReleaseCachedGlobal: 'side-panel:release-cached-global',
});
export const PanelScopeError = Object.freeze({
  OtherWindow: 'OTHER_GLOBAL_PANEL',
  TargetBusy: 'TARGET_PANEL_BUSY',
  CachedGlobalBusy: 'CACHED_GLOBAL_PANEL_BUSY',
});
export const PANEL_SCOPE_TIMEOUT_MS = 10_000;
const GLOBAL_MODE_KEY = 'sidePanelGlobalMode';
const OPEN_GLOBAL_WINDOWS_KEY = 'sidePanelOpenGlobalWindows';
const MODE_KEYS = [GLOBAL_MODE_KEY, OPEN_GLOBAL_WINDOWS_KEY, PANEL_SCOPE_PREFERENCE];
const sidePanelPath = tabId => `${GLOBAL_SIDE_PANEL_PATH}?tabId=${tabId}`;
const isTabId = tabId => Number.isSafeInteger(tabId) && tabId >= 0;

export function supportsGlobalSidePanel(chromeApi) {
  return typeof chromeApi?.sidePanel?.close === 'function' && Boolean(chromeApi.sidePanel.onClosed);
}

export function tabIdFromSidePanelUrl(url, chromeApi) {
  if (typeof url !== 'string') return null;
  try {
    const tabId = Number(new URL(url).searchParams.get('tabId'));
    return isTabId(tabId) && url === chromeApi.runtime.getURL(sidePanelPath(tabId)) ? tabId : null;
  } catch {
    return null;
  }
}

async function configureTabSidePanel(chromeApi, tabId) {
  await chromeApi.sidePanel.setOptions({ tabId, path: sidePanelPath(tabId), enabled: true });
}

export async function openTabSidePanel(chromeApi, tabId, windowId) {
  if (!isTabId(tabId)) throw new TypeError('Invalid side panel tab ID');
  // Keep both calls in the real click's stack. Chrome processes configuration before opening.
  const configured = configureTabSidePanel(chromeApi, tabId);
  const opened = chromeApi.sidePanel.open(windowId === undefined ? { tabId } : { tabId, windowId });
  await Promise.all([configured, opened]);
}

export function initializeTabSidePanel(chromeApi, {
  readContextualPanelProtection = async () => () => false,
  hasWebsitePanelWork = () => false,
} = {}) {
  const globalSupported = supportsGlobalSidePanel(chromeApi);
  const openGlobalWindows = new Set();
  let globalMode = false;
  let preference;
  let followSwitch;
  let modeLoaded = !globalSupported;
  const ready = globalSupported
    ? chromeApi.storage.session.get(MODE_KEYS).then(saved => {
      globalMode = saved[GLOBAL_MODE_KEY] === true;
      preference = saved[PANEL_SCOPE_PREFERENCE];
      for (const windowId of saved[OPEN_GLOBAL_WINDOWS_KEY] ?? []) openGlobalWindows.add(windowId);
    }).catch(() => {}).finally(() => { modeLoaded = true; })
    : Promise.resolve();
  let scopeUpdates = ready;
  const updateScope = operation => {
    const updated = scopeUpdates.then(operation);
    scopeUpdates = updated.catch(() => {});
    return updated;
  };
  const whenReady = action => modeLoaded ? action() : ready.then(action);
  const provision = tabId => {
    if (!isTabId(tabId) || globalMode) return;
    return configureTabSidePanel(chromeApi, tabId);
  };
  const provisionExisting = () => void updateScope(async () => {
    if (globalSupported) await applyPreferredScope();
    if (globalMode) return;
    const tabs = await chromeApi.tabs.query({});
    await Promise.allSettled(tabs.map(tab => provision(tab.id)));
  }).catch(() => {});

  chromeApi.runtime.onInstalled.addListener(provisionExisting);
  chromeApi.runtime.onStartup.addListener(provisionExisting);
  chromeApi.tabs.onCreated.addListener(tab => {
    void updateScope(() => provision(tab.id)).catch(() => {});
  });
  chromeApi.tabs.onReplaced.addListener(tabId => {
    void updateScope(() => provision(tabId)).catch(() => {});
  });
  // Chrome normally handles the toggle itself. A tab without options yet falls through here.
  chromeApi.action.onClicked.addListener(tab => {
    if (!isTabId(tab.id)) return;
    const activate = (useGlobal, globalOpen) => {
      const operation = !useGlobal ? openTabSidePanel(chromeApi, tab.id, tab.windowId)
        : globalOpen ? chromeApi.sidePanel.close({ windowId: tab.windowId })
        : chromeApi.sidePanel.open({ windowId: tab.windowId });
      void operation.catch(() => {});
    };
    if (modeLoaded) {
      activate(globalMode, openGlobalWindows.has(tab.windowId));
      return;
    }
    // The callback from Chrome preserves the click's user activation on worker startup.
    chromeApi.storage.session.get(MODE_KEYS, saved => {
      if (chromeApi.runtime.lastError) return;
      activate(saved[GLOBAL_MODE_KEY] === true, saved[OPEN_GLOBAL_WINDOWS_KEY]?.includes(tab.windowId));
    });
  });
  void chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (!globalSupported) return () => false;

  const saveOpenWindows = () => chromeApi.storage.session.set({ [OPEN_GLOBAL_WINDOWS_KEY]: [...openGlobalWindows] });
  const updateGlobalVisibility = (windowId, open) => {
    void whenReady(() => {
      if (open) openGlobalWindows.add(windowId);
      else openGlobalWindows.delete(windowId);
      return saveOpenWindows();
    }).catch(() => {});
  };
  chromeApi.windows.onRemoved.addListener(windowId => {
    updateGlobalVisibility(windowId, false);
    if (followSwitch?.windowId === windowId) finishFollowSwitch(followSwitch, { ok: false });
    void updateScope(async () => {
      await takeContinuation(windowId, null);
      await applyPreferredScope();
    }).catch(() => {});
  });
  chromeApi.sidePanel.onOpened?.addListener(({ windowId, tabId }) => {
    if (tabId === undefined) updateGlobalVisibility(windowId, true);
    const request = followSwitch;
    if (request && !request.opened && request.windowId === windowId && request.tabId === tabId) {
      request.opened = true;
      clearTimeout(request.timer);
      void updateScope(() => completeFollowSwitch(request)).then(
        result => finishFollowSwitch(request, result), () => finishFollowSwitch(request, { ok: false }),
      );
    }
    void updateScope(() => applyPreferredScope()).catch(() => {});
  });
  chromeApi.sidePanel.onClosed?.addListener(({ windowId, tabId }) => {
    if (tabId === undefined) updateGlobalVisibility(windowId, false);
    void updateScope(() => applyPreferredScope(tabId)).catch(() => {});
  });

  async function retireContextualPanels(tabIds) {
    const options = await Promise.allSettled(tabIds.map(tabId => chromeApi.sidePanel.getOptions({ tabId })));
    const isProtected = await readContextualPanelProtection();
    const contexts = await chromeApi.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    const liveTabs = new Set(contexts.map(context => tabIdFromSidePanelUrl(context.documentUrl, chromeApi)));
    await Promise.allSettled(tabIds.map((tabId, index) => {
      const found = options[index];
      if (found.status === 'fulfilled' && found.value.enabled && found.value.path === sidePanelPath(tabId) &&
          !liveTabs.has(tabId) && !isProtected(tabId)) {
        return chromeApi.sidePanel.setOptions({ tabId, enabled: false });
      }
    }));
  }

  async function applyPreferredScope(closedTabId) {
    if (followSwitch) return;
    if (preference && preference.global !== globalMode) await setPreferredScope(preference);
    else if (globalMode && isTabId(closedTabId)) await retireContextualPanels([closedTabId]);
  }

  const configureDefaultScope = global => chromeApi.sidePanel.setOptions(global
    ? { path: GLOBAL_SIDE_PANEL_PATH, enabled: true }
    : { enabled: false });

  const globalPanelUrl = chromeApi.runtime.getURL(GLOBAL_SIDE_PANEL_PATH);
  const readPanelContexts = documentUrls => chromeApi.runtime.getContexts({
    contextTypes: ['SIDE_PANEL'], documentUrls,
  });

  async function setPreferredScope(next, sourceTabId, { replacedDocumentId, activeTabWindowId, expiresAt } = {}) {
    let apply = next.global !== globalMode;
    if (apply && !next.global) {
      // A contextual view can replace the global panel while Chrome still retains its document.
      const contexts = await readPanelContexts([globalPanelUrl]);
      apply = contexts.every(context => replacedDocumentId && context.documentId === replacedDocumentId);
      if (replacedDocumentId !== undefined && !apply) return { ok: false, code: PanelScopeError.OtherWindow };
      if (activeTabWindowId !== undefined) {
        const tab = await chromeApi.tabs.get(sourceTabId);
        if (!tab?.active || tab.windowId !== activeTabWindowId || Date.now() >= expiresAt) return { ok: false };
      }
    }
    // With the same extension entry registered globally, Chrome keeps the current contextual
    // document and can select the global entry itself when another tab becomes active.
    if (apply) await configureDefaultScope(next.global);
    if (apply || next !== preference) {
      try {
        await chromeApi.storage.session.set({
          [PANEL_SCOPE_PREFERENCE]: next,
          ...(apply ? { [GLOBAL_MODE_KEY]: next.global } : {}),
        });
      } catch (error) {
        if (apply) await configureDefaultScope(globalMode).catch(() => { globalMode = next.global; });
        throw error;
      }
      preference = next;
    }
    if (apply) {
      globalMode = next.global;
      await reconcileTabScopes(sourceTabId).catch(() => {});
    }
    return { ok: true };
  }

  async function reconcileTabScopes(sourceTabId) {
    const tabs = (await chromeApi.tabs.query({})).map(tab => tab.id).filter(isTabId);
    if (globalMode) await retireContextualPanels(tabs.filter(tabId => tabId !== sourceTabId));
    else await Promise.allSettled(tabs.map(tabId => configureTabSidePanel(chromeApi, tabId)));
  }

  async function takeContinuation(windowId, tabId) {
    const pending = preference?.continuations ?? [];
    const matches = entry => entry.windowId === windowId && (tabId === null || entry.tabId === tabId);
    const continuation = pending.find(matches);
    if (!continuation) return undefined;
    const remaining = pending.filter(entry => !matches(entry));
    const next = { global: preference.global, ...(remaining.length > 0 && { continuations: remaining }) };
    await chromeApi.storage.session.set({ [PANEL_SCOPE_PREFERENCE]: next });
    preference = next;
    return { selection: continuation.selection, includePage: continuation.includePage };
  }

  async function prepareFollowSwitch(message, sender) {
    const { windowId, tabId } = message;
    if (!globalMode || followSwitch) return { ok: false };
    const targetUrl = chromeApi.runtime.getURL(sidePanelPath(tabId));
    const isProtected = await readContextualPanelProtection();
    const contexts = await readPanelContexts([globalPanelUrl, targetUrl]);
    const globals = contexts.filter(context => context.documentUrl === globalPanelUrl);
    if (globals.length > 1) return { ok: false, code: PanelScopeError.OtherWindow };
    const sourceDocumentId = globals[0]?.documentId;
    if (!sourceDocumentId || (sender.documentId && sender.documentId !== sourceDocumentId)) return { ok: false };
    if (isProtected(tabId) || contexts.some(context => context.documentUrl === targetUrl)) {
      return { ok: false, code: PanelScopeError.TargetBusy };
    }
    const { promise, resolve } = Promise.withResolvers();
    const request = {
      id: crypto.randomUUID(), windowId, tabId, targetUrl, sourceDocumentId,
      selection: typeof message.selection === 'string' ? message.selection : '',
      includePage: message.includePage === true,
      completion: promise, resolve,
    };
    request.timer = setTimeout(() => cancelFollowSwitch(request), PANEL_SCOPE_TIMEOUT_MS);
    followSwitch = request;
    return { ok: true, followSwitchId: request.id };
  }

  async function followFromContextualPanel(windowId, tabId) {
    const contexts = await readPanelContexts([globalPanelUrl]);
    if (contexts.length === 0) return setPreferredScope({ global: false }, tabId, { replacedDocumentId: null });
    if (contexts.length > 1 || !contexts[0].documentId) return { ok: false, code: PanelScopeError.OtherWindow };

    // Returning to an original tab can leave the global document cached in this window.
    const releaseId = crypto.randomUUID();
    const expiresAt = Date.now() + PANEL_SCOPE_TIMEOUT_MS;
    const cached = await chromeApi.runtime.sendMessage({
      type: SidePanelMessage.ReserveCachedGlobal, windowId, releaseId, expiresAt,
    }).catch(() => undefined);
    if (!cached) return { ok: false, code: PanelScopeError.OtherWindow };
    if (!cached.canRelease) return { ok: false, code: PanelScopeError.CachedGlobalBusy };
    try {
      return await setPreferredScope({ global: false }, tabId, {
        replacedDocumentId: contexts[0].documentId, activeTabWindowId: windowId, expiresAt,
      });
    } finally {
      void chromeApi.runtime.sendMessage({
        type: SidePanelMessage.ReleaseCachedGlobal, windowId, releaseId,
      }).catch(() => {});
    }
  }

  function finishFollowSwitch(request, result) {
    if (followSwitch !== request) return;
    followSwitch = undefined;
    clearTimeout(request.timer);
    request.resolve(result);
  }

  function cancelFollowSwitch(request) {
    if (followSwitch !== request || request.opened) return;
    finishFollowSwitch(request, { ok: false });
    // Registration can succeed even when Chrome rejects the native open.
    void updateScope(async () => {
      if (globalMode) await retireContextualPanels([request.tabId]);
    }).catch(() => {});
  }

  async function completeFollowSwitch(request) {
    const { windowId, tabId, targetUrl, sourceDocumentId, selection, includePage } = request;
    const tab = await chromeApi.tabs.get(tabId);
    const contexts = await readPanelContexts([targetUrl]);
    if (followSwitch !== request || tab?.windowId !== windowId ||
        !contexts.some(context => context.documentUrl === targetUrl)) return { ok: false };
    if (hasWebsitePanelWork(tabId)) return { ok: false, code: PanelScopeError.TargetBusy };
    return setPreferredScope({
      global: false, continuations: [{ windowId, tabId, selection, includePage }],
    }, tabId, { replacedDocumentId: sourceDocumentId });
  }

  void updateScope(() => applyPreferredScope()).catch(() => {});

  return (message, sender, reply) => {
    if (message?.type !== SidePanelMessage.SwitchScope &&
        message?.type !== SidePanelMessage.TakeContinuation &&
        message?.type !== SidePanelMessage.WaitFollowSwitch &&
        message?.type !== SidePanelMessage.CancelFollowSwitch) return false;
    const boundTabId = tabIdFromSidePanelUrl(sender.url, chromeApi);
    const fromGlobal = sender.url === chromeApi.runtime.getURL(GLOBAL_SIDE_PANEL_PATH);
    const { windowId, tabId } = message;
    if (sender.id !== chromeApi.runtime.id || sender.tab || !isTabId(windowId)) {
      reply({ ok: false });
      return true;
    }
    if (message.type === SidePanelMessage.TakeContinuation) {
      if (fromGlobal ? tabId !== undefined : boundTabId === null || boundTabId !== tabId) {
        reply({ ok: false });
        return true;
      }
      const request = followSwitch;
      const pending = request && request.windowId === windowId && request.tabId === tabId ? request.completion : undefined;
      void (async () => {
        const result = await pending;
        if (result && !result.ok) return result;
        return { ok: true, continuation: await updateScope(() => takeContinuation(windowId, tabId)) };
      })().then(reply, () => reply({ ok: false }));
      return true;
    }
    if (message.type === SidePanelMessage.WaitFollowSwitch || message.type === SidePanelMessage.CancelFollowSwitch) {
      const request = followSwitch;
      if (!fromGlobal || !request || request.id !== message.followSwitchId ||
          request.windowId !== windowId || request.tabId !== tabId) reply({ ok: false });
      else if (message.type === SidePanelMessage.WaitFollowSwitch) void request.completion.then(reply);
      else {
        cancelFollowSwitch(request);
        reply({ ok: true });
      }
      return true;
    }
    if (!isTabId(tabId) || typeof message.global !== 'boolean' || (!fromGlobal && boundTabId !== tabId)) {
      reply({ ok: false });
      return true;
    }
    void updateScope(async () => {
      if (followSwitch) return { ok: false };
      const tab = await chromeApi.tabs.get(tabId);
      if (!tab || tab.windowId !== windowId || (!tab.active && (fromGlobal || !message.global))) {
        return { ok: false };
      }
      if (fromGlobal && !message.global) return prepareFollowSwitch(message, sender);
      if (!message.global && globalMode) return followFromContextualPanel(windowId, tabId);
      const next = { global: message.global };
      if (message.global) {
        const pending = preference?.continuations ?? [];
        const continuations = pending.filter(entry => entry.windowId !== windowId);
        if (!fromGlobal && typeof message.selection === 'string') {
          continuations.push({ windowId, selection: message.selection, includePage: message.includePage === true });
        }
        if (continuations.length > 0) next.continuations = continuations;
      }
      return setPreferredScope(next, tabId);
    }).then(reply, () => reply({ ok: false }));
    return true;
  };
}
