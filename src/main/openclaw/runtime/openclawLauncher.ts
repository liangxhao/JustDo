export const OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE =
  `const _keepAlive = process.argv[2] === 'gateway'\n` +
  `  ? setInterval(() => {}, 30000)\n` +
  `  : undefined;\n`;
