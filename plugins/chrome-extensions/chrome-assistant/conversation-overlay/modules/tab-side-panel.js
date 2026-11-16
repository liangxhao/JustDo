const sidePanelPath = tabId => `sidepanel.html?tabId=${tabId}`;
const isTabId = tabId => Number.isSafeInteger(tabId) && tabId >= 0;

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

export async function openTabSidePanel(chromeApi, tabId) {
  if (!isTabId(tabId)) throw new TypeError('Invalid side panel tab ID');
  // Keep both calls in the real click's stack. Chrome processes configuration before opening.
  const configured = configureTabSidePanel(chromeApi, tabId);
  const opened = chromeApi.sidePanel.open({ tabId });
  await Promise.all([configured, opened]);
}

export function initializeTabSidePanel(chromeApi) {
  const provision = tabId => {
    if (isTabId(tabId)) void configureTabSidePanel(chromeApi, tabId).catch(() => {});
  };
  const provisionExisting = () => {
    void chromeApi.tabs
      .query({})
      .then(tabs => {
        for (const tab of tabs) provision(tab.id);
      })
      .catch(() => {});
  };

  chromeApi.runtime.onInstalled.addListener(provisionExisting);
  chromeApi.runtime.onStartup.addListener(provisionExisting);
  chromeApi.tabs.onCreated.addListener(tab => provision(tab.id));
  chromeApi.tabs.onReplaced.addListener(provision);
  // Chrome normally handles the toggle itself. A tab without options yet falls through here.
  chromeApi.action.onClicked.addListener(tab => {
    if (isTabId(tab.id)) void openTabSidePanel(chromeApi, tab.id).catch(() => {});
  });
  void chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
