import fs from 'fs';
import path from 'path';

export const OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE = 'justdo:gateway:shutdown';

export const OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE =
  `const _keepAlive = process.argv[2] === 'gateway'\n` +
  `  ? setInterval(() => {}, 30000)\n` +
  `  : undefined;\n`;

const OPENCLAW_GATEWAY_SHUTDOWN_SOURCE =
  `if (process.argv[2] === 'gateway' && process.channel) {\n` +
  `  let stopping = false;\n` +
  `  const shutdown = () => {\n` +
  `    if (stopping) return;\n` +
  `    stopping = true;\n` +
  `    if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM', 'SIGTERM');\n` +
  `    else process.exit(0);\n` +
  `  };\n` +
  `  process.on('message', message => {\n` +
  `    if (message === '${OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE}') shutdown();\n` +
  `  });\n` +
  `  process.once('disconnect', shutdown);\n` +
  `  process.channel.unref();\n` +
  `}\n`;

export function ensureGatewayShutdownPreload(directory: string): string {
  const preloadPath = path.join(directory, 'gateway-shutdown.cjs');
  fs.mkdirSync(directory, { recursive: true });
  if (
    !fs.existsSync(preloadPath) ||
    fs.readFileSync(preloadPath, 'utf8') !== OPENCLAW_GATEWAY_SHUTDOWN_SOURCE
  ) {
    fs.writeFileSync(preloadPath, OPENCLAW_GATEWAY_SHUTDOWN_SOURCE, 'utf8');
  }
  return preloadPath;
}
