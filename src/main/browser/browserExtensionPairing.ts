import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { OpenClawCliEnvironment } from '../openclaw/runtime/openclawEngineManager';

const execFileAsync = promisify(execFile);
type PairingTransport = 'relay' | 'gateway';

export async function readAutomaticBrowserExtensionPairing(
  ensureEngineRunning: () => Promise<{ phase: string }>,
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>,
  runPairCommand?: (cli: OpenClawCliEnvironment) => Promise<string>,
): Promise<{ pairingString: string; relayPort: number }> {
  const status = await ensureEngineRunning();
  if (status.phase !== 'running') throw new Error('Browser extension pairing is unavailable.');
  return readBrowserExtensionPairing(buildCliEnvironment, 'gateway', runPairCommand);
}

export const buildBrowserPairingCommandEnvironment = (
  cli: OpenClawCliEnvironment,
): NodeJS.ProcessEnv => ({
  ...cli.env,
  ELECTRON_RUN_AS_NODE: '1',
  // The supported Electron Node runtime must not be respawned as electron.exe.
  OPENCLAW_NO_RESPAWN: '1',
});

const OPENCLAW_ELECTRON_CLI_BOOTSTRAP =
  "process.argv[0]='node';import(require('node:url').pathToFileURL(process.argv[1]).href)";

export const buildBrowserExtensionPairingCommandArgs = (
  openclawEntry: string,
  transport: PairingTransport = 'relay',
): string[] => [
  '-e',
  OPENCLAW_ELECTRON_CLI_BOOTSTRAP,
  openclawEntry,
  'browser',
  'extension',
  'pair',
  ...(transport === 'gateway' ? ['--local-gateway'] : []),
  '--json',
];

export async function readBrowserExtensionPairing(
  buildCliEnvironment: () => Promise<OpenClawCliEnvironment>,
  transport: PairingTransport = 'relay',
  runPairCommand?: (cli: OpenClawCliEnvironment) => Promise<string>,
): Promise<{ pairingString: string; relayPort: number }> {
  const invalid = () => new Error('OpenClaw returned an invalid browser extension pairing result.');
  const cli = await buildCliEnvironment();
  let raw: string;
  if (runPairCommand) {
    raw = await runPairCommand(cli);
  } else {
    // A child-process error may contain stdout (the pairing secret). Never
    // forward that error to the extension, Renderer or application logs.
    try {
      const result = await execFileAsync(
        cli.env.JUSTDO_ELECTRON_PATH?.trim() || process.execPath,
        buildBrowserExtensionPairingCommandArgs(cli.openclawEntry, transport),
        {
          cwd: cli.runtimeRoot,
          env: buildBrowserPairingCommandEnvironment(cli),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      raw = result.stdout;
    } catch {
      throw new Error('Browser extension pairing is unavailable.');
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const { pairingString, relayPort, remote } = value as {
    pairingString?: unknown;
    relayPort?: unknown;
    remote?: unknown;
  };
  if (
    typeof pairingString !== 'string' ||
    !Number.isInteger(relayPort) ||
    (relayPort as number) < 1 ||
    (relayPort as number) > 65_535
  )
    throw invalid();
  const fragmentAt = pairingString.lastIndexOf('#');
  let relayUrl: URL;
  try {
    relayUrl = new URL(pairingString.slice(0, fragmentAt));
  } catch {
    throw invalid();
  }
  if (
    fragmentAt <= 0 ||
    !/^[0-9a-f]{64}$/.test(pairingString.slice(fragmentAt + 1)) ||
    relayUrl.protocol !== 'ws:' ||
    relayUrl.hostname !== '127.0.0.1' ||
    relayUrl.pathname !== (transport === 'gateway' ? '/browser/extension' : '/extension') ||
    Number(relayUrl.port) !== (transport === 'gateway' ? cli.port : relayPort) ||
    relayUrl.username ||
    relayUrl.password
  )
    throw invalid();
  if (transport === 'gateway') {
    let gateway: URL;
    try {
      gateway = new URL(relayUrl.searchParams.get('gateway') ?? '');
    } catch {
      throw invalid();
    }
    if (
      remote !== false ||
      gateway.origin !== relayUrl.origin ||
      gateway.pathname !== '/' ||
      gateway.username ||
      gateway.password ||
      gateway.search ||
      gateway.hash
    )
      throw invalid();
  }
  return { pairingString, relayPort: relayPort as number };
}
