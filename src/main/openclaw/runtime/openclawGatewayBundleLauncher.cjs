'use strict';

const fs = require('fs');
const path = require('path');

const GATEWAY_LAUNCHER_FILENAME = 'gateway-launcher.cjs';
const GATEWAY_BUNDLE_FILENAME = 'gateway-bundle.mjs';
const GATEWAY_READY_MESSAGE = 'justdo:gateway:ready';

function buildOpenClawGatewayBundleLauncherSource() {
  return (
    `// Auto-generated CJS launcher for Windows — bundle-only mode.\n` +
    `// Loads gateway-bundle.mjs directly without dist/ fallback.\n` +
    `const { pathToFileURL } = require('node:url');\n` +
    `const path = require('node:path');\n` +
    `const fs = require('node:fs');\n` +
    `const _log = (msg) => process.stderr.write('[openclaw-launcher] ' + msg + '\\n');\n` +
    `const _t0 = Date.now();\n` +
    `const _elapsed = () => (Date.now() - _t0) + 'ms';\n` +
    `// ─── Compile cache setup ───\n` +
    `try {\n` +
    `  const { enableCompileCache, getCompileCacheDir } = require('node:module');\n` +
    `  const _ccDir = path.join(process.env.OPENCLAW_STATE_DIR || __dirname, '.compile-cache');\n` +
    `  enableCompileCache(_ccDir);\n` +
    `  _log('compile-cache dir=' + getCompileCacheDir());\n` +
    `} catch (_) {}\n` +
    `// ─── Load bundle ───\n` +
    `const bundlePath = path.join(__dirname, '${GATEWAY_BUNDLE_FILENAME}');\n` +
    `const _realpath = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };\n` +
    `const _launcherInArgv = process.argv[1] &&\n` +
    `  _realpath(process.argv[1]).toLowerCase() === _realpath(__filename).toLowerCase();\n` +
    `if (_launcherInArgv) {\n` +
    `  process.argv[1] = bundlePath;\n` +
    `} else {\n` +
    `  process.argv.splice(1, 0, bundlePath);\n` +
    `}\n` +
    `// OpenClaw recognizes Node runtimes from argv[0]. Electron keeps its own\n` +
    `// executable path in that slot even with ELECTRON_RUN_AS_NODE=1.\n` +
    `process.argv[0] = 'node';\n` +
    `// Keep only the Gateway alive. One-shot CLI commands must exit normally.\n` +
    `const _keepAlive = process.argv[2] === 'gateway'\n` +
    `  ? setInterval(() => {}, 30000)\n` +
    `  : undefined;\n` +
    `const bundleUrl = pathToFileURL(bundlePath).href;\n` +
    `// Gateway top-level await can keep import() pending for its entire life.\n` +
    `// Persist compiled modules before Windows terminates the process.\n` +
    `const _flushCache = () => { try { require('node:module').flushCompileCache(); } catch (_) {} };\n` +
    `let _cacheFlushTimer;\n` +
    `const _startCacheFlush = () => {\n` +
    `  if (!_cacheFlushTimer) {\n` +
    `    _cacheFlushTimer = setInterval(_flushCache, 5000);\n` +
    `    _cacheFlushTimer.unref();\n` +
    `  }\n` +
    `};\n` +
    `if (_keepAlive && process.channel) {\n` +
    `  // Cache serialization is synchronous: keep it off the startup critical path.\n` +
    `  const _onReady = message => {\n` +
    `    if (message !== '${GATEWAY_READY_MESSAGE}') return;\n` +
    `    process.removeListener('message', _onReady);\n` +
    `    _startCacheFlush();\n` +
    `  };\n` +
    `  process.on('message', _onReady);\n` +
    `  process.channel.unref();\n` +
    `} else if (_keepAlive) {\n` +
    `  _startCacheFlush();\n` +
    `}\n` +
    `_log('loading bundle (' + _elapsed() + ')');\n` +
    `import(bundleUrl).then(() => {\n` +
    `  _log('import ok (' + _elapsed() + ')');\n` +
    `  if (!_keepAlive || !process.channel) _flushCache();\n` +
    `}).catch((err) => {\n` +
    `  _log('import failed (' + _elapsed() + '): ' + (err.stack || err));\n` +
    `  process.exit(1);\n` +
    `});\n`
  );
}

function ensureOpenClawGatewayBundleLauncher(runtimeRoot) {
  const bundlePath = path.join(runtimeRoot, GATEWAY_BUNDLE_FILENAME);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`OpenClaw gateway bundle not found: ${bundlePath}`);
  }

  const launcherPath = path.join(runtimeRoot, GATEWAY_LAUNCHER_FILENAME);
  const expectedContent = buildOpenClawGatewayBundleLauncherSource();
  const existingContent = fs.existsSync(launcherPath)
    ? fs.readFileSync(launcherPath, 'utf8')
    : '';
  const changed = existingContent !== expectedContent;
  if (changed) {
    fs.writeFileSync(launcherPath, expectedContent, 'utf8');
  }

  return {
    changed,
    launcherPath,
    replaced: changed && existingContent.length > 0,
  };
}

module.exports = {
  GATEWAY_READY_MESSAGE,
  GATEWAY_BUNDLE_FILENAME,
  GATEWAY_LAUNCHER_FILENAME,
  buildOpenClawGatewayBundleLauncherSource,
  ensureOpenClawGatewayBundleLauncher,
};
