const developmentParent = require('../../src/shared/app/developmentParent.json');

// Main's development cleanup allows 30s plus a bounded 17s emergency stop.
const ELECTRON_SHUTDOWN_GRACE_MS = 50_000;

function stopElectron(child, graceMs = ELECTRON_SHUTDOWN_GRACE_MS) {
  if (!child || !child.pid || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise(resolve => {
    let finished = false;
    let forceTimer;
    let exitTimer;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(forceTimer);
      clearTimeout(exitTimer);
      child.removeListener('close', done);
      child.removeListener('message', onMessage);
      resolve();
    };
    const onMessage = message => {
      // A later terminal may have adopted this same application window. Its
      // original launcher must not kill the new development session.
      if (message === developmentParent.released) done();
    };
    child.once('close', done);
    child.on('message', onMessage);
    forceTimer = setTimeout(() => {
      console.error('[Electron Launcher] Graceful shutdown timed out; forcing Electron to exit.');
      exitTimer = setTimeout(done, 5_000);
      try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }, graceMs);
    try {
      if (child.connected) {
        child.send(developmentParent.shutdown, () => {
          // A closing IPC channel does not prove that Main has finished cleanup.
        });
      }
    } catch {
      // Keep the grace window: server-loss detection can also request app.quit().
    }
  });
}

module.exports = { stopElectron, ELECTRON_SHUTDOWN_GRACE_MS };
