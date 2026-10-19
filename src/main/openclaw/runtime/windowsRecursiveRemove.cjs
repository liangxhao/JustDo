'use strict';

// Electron 42's Windows synchronous recursive rm follows directory junctions.
// Keep native leaf operations, but never pass a recursive directory to it.
// This function is serialized into the standalone Gateway launcher.
function installWindowsRecursiveRemove(preloadPath) {
  if (process.platform !== 'win32' || !process.versions.electron) return;
  const fs = require('node:fs');
  const installed = Symbol.for('runtime.windowsRecursiveRemove');
  if (fs[installed]) return;
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');
  const original = fs.rmSync;
  const retryable = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
  fs.rmSync = function rmSync(target, options) {
    if (options?.recursive !== true || typeof options !== 'object' || Array.isArray(options)) {
      return original(target, options);
    }
    options = { ...options };
    const filename = target instanceof URL ? fileURLToPath(target)
      : Buffer.isBuffer(target) ? target.toString() : target;
    const remove = (entry, force) => {
      try {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(entry);
          return;
        }
        if (!stat.isDirectory()) {
          original(entry, { ...options, recursive: false, force });
          return;
        }
        for (const child of fs.readdirSync(entry)) remove(path.join(entry, child), true);
        fs.rmdirSync(entry);
      } catch (error) {
        if (force && error.code === 'ENOENT') return;
        throw error;
      }
    };
    for (let attempt = 0; ; attempt++) {
      try {
        // Native nonrecursive removal validates every option before mutation.
        // Keep it inside the retry loop: files can also fail with EBUSY/EPERM.
        try {
          return original(target, { ...options, recursive: false });
        } catch (error) {
          if (error.code !== 'ERR_FS_EISDIR') throw error;
        }
        return remove(filename, options.force === true);
      } catch (error) {
        if (!retryable.has(error.code) || attempt >= (options.maxRetries ?? 0)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
          (options.retryDelay ?? 100) * (attempt + 1));
      }
    }
  };
  if (preloadPath) {
    // Native pools explicitly pass execArgv: []; process.execArgv inheritance
    // alone cannot protect those workers. Preload before their entry modules,
    // and install the same constructor in nested workers.
    const threads = require('node:worker_threads');
    const NativeWorker = threads.Worker;
    // A default Worker inherits startup preloads while Node filters flags that
    // cannot be passed explicitly (such as --max-old-space-size). Main can also
    // install this helper by require(), so only skip injection when this exact
    // preload was already a startup option. The generated NODE_OPTIONS uses
    // --require="absolute/path"; preserve quoted Chinese/space paths as one token.
    const startupOptions = [
      ...process.execArgv,
      ...(process.env.NODE_OPTIONS?.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
        .map(value => value.replace(/"/g, '')),
    ];
    const isPreloadPath = value => typeof value === 'string' &&
      path.resolve(value).toLowerCase() === path.resolve(preloadPath).toLowerCase();
    const inheritsPreload = startupOptions.some((option, index) =>
      ((option === '--require' || option === '-r') && isPreloadPath(startupOptions[index + 1])) ||
      (option.startsWith('--require=') && isPreloadPath(option.slice('--require='.length))));
    threads.Worker = class Worker extends NativeWorker {
      constructor(filename, options = {}) {
        if (options?.execArgv === undefined && inheritsPreload) {
          super(filename, options);
          return;
        }
        const execArgv = options?.execArgv ?? process.execArgv;
        if (!Array.isArray(execArgv)) {
          super(filename, options);
          return;
        }
        const preload = `--require=${preloadPath}`;
        super(filename, {
          ...options,
          execArgv: [preload, ...execArgv.filter(arg => arg !== preload)],
        });
      }
    };
  }
  Object.defineProperty(fs, installed, { value: true });
  require('node:module').syncBuiltinESMExports();
}

module.exports = { installWindowsRecursiveRemove };
