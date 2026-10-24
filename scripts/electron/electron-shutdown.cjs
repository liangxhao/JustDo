const developmentParent = require('../../src/shared/app/developmentParent.json');
const policy = require('../../src/shared/app/shutdownPolicy.json');

const ELECTRON_SHUTDOWN_GRACE_MS = policy.startupAbortMs + policy.forceExitObservationMs +
  policy.otherAppCleanupMs + policy.nativeShutdownMs + policy.nativeExitMarginMs +
  policy.forceExitObservationMs + 2 * policy.outerSchedulingMarginMs;
const records = new WeakMap();

function observeElectron(child) {
  if (!child || records.has(child)) return;
  const record = { closed: false, released: false, code: null, signal: null };
  records.set(child, record);
  child.once('close', (code, signal) => {
    record.closed = true;
    record.code = code;
    record.signal = signal;
    record.finish?.();
  });
}

function stopElectron(child, graceMs = ELECTRON_SHUTDOWN_GRACE_MS) {
  if (!child) return Promise.resolve();
  observeElectron(child);
  const record = records.get(child);
  if (record.promise) return record.promise;
  let resolve, reject;
  record.promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  let finished = false;
  let forced = false;
  let forceTimer, exitTimer;
  const done = () => {
    if (finished || !record.closed && !record.released) return;
    finished = true;
    clearTimeout(forceTimer);
    clearTimeout(exitTimer);
    child.removeListener('message', onMessage);
    if (record.released && !forced) resolve();
    else if (forced || record.code !== 0 || record.signal)
      reject(new Error('Electron did not close cleanly; application cleanup remains unconfirmed.'));
    else resolve();
  };
  const onMessage = message => {
    // Explicit handoff retires this launcher's ownership; it is not a process exit.
    if (message === developmentParent.released) {
      record.released = true;
      done();
    }
  };
  record.finish = done;
  child.on('message', onMessage);
  if (record.closed) { done(); return record.promise; }
  forceTimer = setTimeout(() => {
    forced = true;
    console.error('[Electron Launcher] Graceful shutdown timed out; forcing Electron to exit.');
    exitTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.removeListener('message', onMessage);
      reject(new Error('Electron process retirement could not be confirmed.'));
      // Keep the child record and close observer. A late close cannot erase failure.
    }, policy.forceExitObservationMs);
    // exitCode/signalCode can precede close while inherited stdio is still open.
    if (child.exitCode == null && child.signalCode == null) {
      try { child.kill('SIGKILL'); } catch { /* Actual close is still required. */ }
    }
  }, graceMs);
  try {
    if (child.connected) child.send(developmentParent.shutdown, () => {});
  } catch { /* Closing IPC is not a cleanup receipt. Keep the same grace. */ }
  return record.promise;
}

module.exports = { stopElectron, observeElectron, ELECTRON_SHUTDOWN_GRACE_MS };
