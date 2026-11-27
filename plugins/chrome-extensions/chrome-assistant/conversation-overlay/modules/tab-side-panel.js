export const GLOBAL_SIDE_PANEL_PATH = 'sidepanel.html';
export const SidePanelMessage = Object.freeze({
  RestoreSelection: 'side-panel:restore-selection',
  SwitchScope: 'side-panel:switch-scope',
  GlobalDraftState: 'side-panel:global-draft-state',
});
const GLOBAL_MODE_KEY = 'sidePanelGlobalMode';
const OPEN_GLOBAL_WINDOWS_KEY = 'sidePanelOpenGlobalWindows';
const BUSY_GLOBAL_WINDOWS_KEY = 'sidePanelBusyGlobalWindows';
const MODE_KEYS = [GLOBAL_MODE_KEY, OPEN_GLOBAL_WINDOWS_KEY, BUSY_GLOBAL_WINDOWS_KEY];
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
  const busyGlobalWindows = new Map();
  const handoffs = new Map();
  let globalMode = false;
  let transition;
  let modeLoaded = !globalSupported;
  const ready = globalSupported
    ? chromeApi.storage.session.get(MODE_KEYS).then(saved => {
      globalMode = saved[GLOBAL_MODE_KEY] === true;
      for (const windowId of saved[OPEN_GLOBAL_WINDOWS_KEY] ?? []) openGlobalWindows.add(windowId);
      for (const [windowId, documentId] of saved[BUSY_GLOBAL_WINDOWS_KEY] ?? []) {
        busyGlobalWindows.set(windowId, documentId);
      }
    }).catch(() => {}).finally(() => { modeLoaded = true; })
    : Promise.resolve();
  const whenReady = action => modeLoaded ? action() : ready.then(action);
  const provision = tabId => {
    if (transition) return transition.catch(() => {}).then(() => provision(tabId));
    if (!isTabId(tabId) || globalMode) return;
    return configureTabSidePanel(chromeApi, tabId);
  };
  const provisionExisting = () => {
    void whenReady(() => chromeApi.tabs.query({}))
      .then(tabs => Promise.allSettled(tabs.map(tab => provision(tab.id)))).catch(() => {});
  };

  chromeApi.runtime.onInstalled.addListener(provisionExisting);
  chromeApi.runtime.onStartup.addListener(provisionExisting);
  chromeApi.tabs.onCreated.addListener(tab => {
    void Promise.resolve(whenReady(() => provision(tab.id))).catch(() => {});
  });
  chromeApi.tabs.onReplaced.addListener(tabId => {
    void Promise.resolve(whenReady(() => provision(tabId))).catch(() => {});
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
  const saveBusyWindows = () => chromeApi.storage.session.set({ [BUSY_GLOBAL_WINDOWS_KEY]: [...busyGlobalWindows] });
  const updateGlobalVisibility = (windowId, open) => {
    void whenReady(() => {
      if (open) openGlobalWindows.add(windowId);
      else openGlobalWindows.delete(windowId);
      return saveOpenWindows();
    }).catch(() => {});
  };
  chromeApi.windows.onRemoved.addListener(windowId => {
    handoffs.delete(windowId);
    updateGlobalVisibility(windowId, false);
    void Promise.resolve(whenReady(() => {
      if (busyGlobalWindows.delete(windowId)) return saveBusyWindows();
    })).catch(() => {});
  });
  chromeApi.sidePanel.onOpened?.addListener(({ windowId, tabId, path }) => {
    if (tabId === undefined && path === GLOBAL_SIDE_PANEL_PATH) updateGlobalVisibility(windowId, true);
  });
  chromeApi.sidePanel.onClosed?.addListener(({ windowId, tabId }) => {
    if (tabId === undefined) updateGlobalVisibility(windowId, false);
  });

  async function retireContextualPanel(tabId, isProtected) {
    const options = await chromeApi.sidePanel.getOptions({ tabId });
    if (options.enabled && options.path === sidePanelPath(tabId) && !isProtected(tabId)) {
      await chromeApi.sidePanel.setOptions({ tabId, enabled: false });
    }
  }

  async function switchScope(tabId, windowId, toGlobal) {
    if (toGlobal) {
      // Deregister the current contextual panel before opening the window entry.
      // Chrome checks the user gesture on open, before any asynchronous follow-up.
      const configured = chromeApi.sidePanel.setOptions({ path: GLOBAL_SIDE_PANEL_PATH, enabled: true });
      const disabled = chromeApi.sidePanel.setOptions({ tabId, enabled: false });
      const opened = chromeApi.sidePanel.open({ windowId });
      try {
        await Promise.all([configured, disabled, opened]);
      } catch (error) {
        await ready;
        if (!globalMode) await chromeApi.sidePanel.setOptions({ enabled: false }).catch(() => {});
        await configureTabSidePanel(chromeApi, tabId).catch(() => {});
        throw error;
      }
    } else {
      await openTabSidePanel(chromeApi, tabId, windowId);
      // A registered global entry makes Chromium select panels with the same key on tab changes.
      await chromeApi.sidePanel.setOptions({ enabled: false });
    }
    await ready;
    const modeChanged = globalMode !== toGlobal;
    globalMode = toGlobal;
    if (!modeChanged) return;
    await chromeApi.storage.session.set({ [GLOBAL_MODE_KEY]: globalMode });
    const tabs = await chromeApi.tabs.query({});
    const isProtected = toGlobal ? await readContextualPanelProtection() : undefined;
    await Promise.allSettled(tabs.filter(tab => isTabId(tab.id) && tab.id !== tabId).map(tab =>
      isProtected
        ? retireContextualPanel(tab.id, isProtected)
        : configureTabSidePanel(chromeApi, tab.id),
    ));
  }

  function startSwitch(message, fromGlobal, otherBusy, reply) {
    const { windowId, tabId } = message;
    if (fromGlobal && otherBusy) {
      reply({ ok: false, otherWindowBusy: true });
      return;
    }
    if (!isTabId(tabId) || transition) {
      reply({ ok: false });
      return;
    }
    // The Chrome API callback retains the click's activation while checking the current tab.
    chromeApi.tabs.get(tabId, tab => {
      if (chromeApi.runtime.lastError || !tab?.active || tab.windowId !== windowId || transition) {
        reply({ ok: false });
        return;
      }
      if (!fromGlobal && hasWebsitePanelWork(tabId)) {
        reply({ ok: false, panelBusy: true });
        return;
      }
      const handoff = {
        tabId: fromGlobal ? tabId : null,
        selection: typeof message.selection === 'string' ? message.selection : '',
        expiresAt: Date.now() + 10_000,
      };
      handoffs.set(windowId, handoff);
      setTimeout(() => {
        if (handoffs.get(windowId) === handoff) handoffs.delete(windowId);
      }, 10_000);
      transition = switchScope(tabId, windowId, !fromGlobal);
      void transition.then(() => {
        transition = undefined;
        reply({ ok: true });
      }, () => {
        transition = undefined;
        if (handoffs.get(windowId) === handoff) handoffs.delete(windowId);
        reply({ ok: false });
      });
    });
  }

  function checkOtherGlobalDrafts(message, entries, reply) {
    const otherDocuments = new Set(entries.filter(([windowId]) => windowId !== message.windowId)
      .map(([, documentId]) => documentId));
    if (!otherDocuments.size) {
      startSwitch(message, true, false, reply);
      return;
    }
    // A website panel can temporarily replace a global view while Chrome retains its document.
    chromeApi.runtime.getContexts({
      contextTypes: ['SIDE_PANEL'],
      documentUrls: [chromeApi.runtime.getURL(GLOBAL_SIDE_PANEL_PATH)],
    }, contexts => {
      if (chromeApi.runtime.lastError) reply({ ok: false });
      else startSwitch(message, true, contexts.some(context => otherDocuments.has(context.documentId)), reply);
    });
  }

  return (message, sender, reply) => {
    if (message?.type !== SidePanelMessage.RestoreSelection && message?.type !== SidePanelMessage.SwitchScope &&
        message?.type !== SidePanelMessage.GlobalDraftState) return false;
    const boundTabId = tabIdFromSidePanelUrl(sender.url, chromeApi);
    const fromGlobal = sender.url === chromeApi.runtime.getURL(GLOBAL_SIDE_PANEL_PATH);
    const { windowId, tabId } = message;
    if (sender.id !== chromeApi.runtime.id || sender.tab || !isTabId(windowId) ||
        (!fromGlobal && (boundTabId === null || boundTabId !== tabId))) {
      reply({ ok: false });
      return true;
    }
    if (message.type === SidePanelMessage.RestoreSelection) {
      const handoff = handoffs.get(windowId);
      const matches = handoff?.tabId === (fromGlobal ? null : boundTabId);
      if (matches) handoffs.delete(windowId);
      reply({ ok: true, selection: matches && Date.now() < handoff.expiresAt ? handoff.selection : undefined });
      return true;
    }
    if (message.type === SidePanelMessage.GlobalDraftState) {
      if (!fromGlobal || typeof sender.documentId !== 'string') {
        reply({ ok: false });
        return true;
      }
      void whenReady(() => {
        if (message.busy === true) busyGlobalWindows.set(windowId, sender.documentId);
        else if (busyGlobalWindows.get(windowId) === sender.documentId) busyGlobalWindows.delete(windowId);
        return saveBusyWindows();
      }).then(() => reply({ ok: true }), () => reply({ ok: false }));
      return true;
    }
    if (!fromGlobal) {
      startSwitch(message, false, false, reply);
    } else if (modeLoaded) {
      checkOtherGlobalDrafts(message, [...busyGlobalWindows], reply);
    } else {
      chromeApi.storage.session.get(BUSY_GLOBAL_WINDOWS_KEY, saved => {
        if (chromeApi.runtime.lastError) reply({ ok: false });
        else checkOtherGlobalDrafts(message, saved[BUSY_GLOBAL_WINDOWS_KEY] ?? [], reply);
      });
    }
    return true;
  };
}
