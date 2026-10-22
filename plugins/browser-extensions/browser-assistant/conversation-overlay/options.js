import { localizeOptions, t } from './modules/options-i18n.js';

localizeOptions();
const connectionStatus = document.getElementById('connectionStatus');
const bootstrapStatus = document.getElementById('bootstrapStatus');
const accessMode = document.getElementById('accessMode');
const pairingString = document.getElementById('pairingString');
const pair = document.getElementById('pair');
const useLocal = document.getElementById('useLocal');
const disconnectAutomatic = document.getElementById('disconnectAutomatic');
const disconnectManual = document.getElementById('disconnectManual');
const message = document.getElementById('message');
const retiredCustody = document.getElementById('retiredCustody');
let currentStatus;
let busy = false;
let disposed = false;
let refreshSequence = 0;

function updateControls() {
  const blocked = currentStatus?.retiredCopilotCustodyBlocked === true;
  const unavailable = busy || !currentStatus;
  useLocal.disabled = unavailable || blocked;
  accessMode.disabled = unavailable || !currentStatus?.paired || blocked;
  pairingString.disabled = unavailable || blocked;
  pair.disabled = unavailable || blocked || !pairingString.value.trim();
  disconnectAutomatic.disabled =
    unavailable ||
    (!currentStatus?.paired && currentStatus?.nativeBootstrap?.disabled === true && !blocked);
  disconnectManual.disabled = unavailable || (!currentStatus?.paired && !blocked);
}

async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (disposed || sequence !== refreshSequence) return;
    if (!status || status.ok === false) throw new Error('Status unavailable');
    currentStatus = status;
    const custodyBlocked = status.retiredCopilotCustodyBlocked === true;
    retiredCustody.classList.toggle('hidden', !custodyBlocked);
    connectionStatus.textContent = t(
      custodyBlocked
        ? 'paused'
        : status.paired
          ? status.state === 'on'
            ? 'connected'
            : status.state === 'connecting'
              ? 'connecting'
              : 'unavailable'
          : 'notPaired',
    );
    connectionStatus.dataset.state = custodyBlocked ? 'paused' : status.state;
    bootstrapStatus.textContent = t(
      status.nativeBootstrap?.disabled
        ? 'automaticDisabled'
        : status.nativeBootstrap?.state === 'manual_required'
          ? 'manualRequired'
          : ['retrying', 'waiting'].includes(status.nativeBootstrap?.state)
            ? 'waitingLocal'
            : 'automaticReady',
    );
    accessMode.value = status.accessMode === 'selected' ? 'selected' : 'all';
  } catch {
    if (disposed || sequence !== refreshSequence) return;
    currentStatus = undefined;
    connectionStatus.textContent = t('statusFailed');
    connectionStatus.dataset.state = 'off';
  }
  updateControls();
}

async function perform(task, success, onSuccess = () => {}, progress) {
  if (busy || disposed) return;
  busy = true;
  refreshSequence += 1;
  updateControls();
  message.textContent = progress ? t(progress) : '';
  message.dataset.error = 'false';
  try {
    const result = await task();
    if (!result || result.ok === false) {
      throw new Error(
        result?.error === 'Invalid pairing string.' ? 'invalidPairing' : 'operationFailed',
      );
    }
    onSuccess();
    message.textContent = t(typeof success === 'function' ? success(result) : success);
  } catch (error) {
    message.textContent = t(
      error instanceof Error && error.message === 'invalidPairing'
        ? 'invalidPairing'
        : 'operationFailed',
    );
    message.dataset.error = 'true';
  } finally {
    busy = false;
    if (!disposed) await refresh();
  }
}

useLocal.addEventListener('click', () => {
  void perform(
    () => chrome.runtime.sendMessage({ type: 'setNativeBootstrapEnabled', enabled: true }),
    result => {
      const status = result.result?.status;
      return status === 'paired' || status === 'existing'
        ? 'paired'
        : status === 'manual_required'
          ? 'manualRequired'
          : 'automaticFailed';
    },
    () => {},
    'lookingLocal',
  );
});
pairingString.addEventListener('input', updateControls);
pair.addEventListener('click', () => {
  const pendingPairingString = pairingString.value;
  if (!pendingPairingString.trim()) return;
  void perform(
    () =>
      chrome.runtime.sendMessage({
        type: 'pair',
        pairingString: pendingPairingString,
        accessMode: accessMode.value,
      }),
    'paired',
    () => {
      if (pairingString.value === pendingPairingString) pairingString.value = '';
    },
  );
});
for (const button of [disconnectAutomatic, disconnectManual]) {
  button.addEventListener('click', () => {
    void perform(() => chrome.runtime.sendMessage({ type: 'unpair' }), 'disconnected');
  });
}
accessMode.addEventListener('change', () => {
  void perform(
    () => chrome.runtime.sendMessage({ type: 'setAccessMode', accessMode: accessMode.value }),
    'accessSaved',
  );
});

connectionStatus.textContent = t('checking');
void refresh();
const statusRefreshTimer = setInterval(() => {
  if (!document.hidden && !busy) void refresh();
}, 2_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy && !disposed) void refresh();
});
window.addEventListener(
  'pagehide',
  () => {
    disposed = true;
    refreshSequence += 1;
    clearInterval(statusRefreshTimer);
  },
  { once: true },
);
