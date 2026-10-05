import { spawn } from 'child_process';

import { OpenClawToolName } from '../../../shared/openclaw/extensions';

const OUTPUT_PREFIX = 'JUSTDO_COMPUTER_POLICY=';
const POLICY_TIMEOUT_MS = 10_000;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 4096;
const POLICY_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = path.join(process.argv[1], 'dist');
const load = async (prefix, name) => {
  const files = fs.readdirSync(dist).filter(file => file.startsWith(prefix) && /\.m?js$/u.test(file));
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(value => typeof value === 'function' && value.name === name);
    if (fn) return fn;
  }
  throw new Error('Native policy export unavailable');
};
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > ${MAX_POLICY_BYTES}) throw new Error('Policy input too large');
}
const tools = JSON.parse(input);
const resolve = await load('agent-tools.policy-', 'resolveConfiguredToolPolicies');
const match = await load('tool-policy-match-', 'createToolPolicyMatcher');
const policies = resolve({ cfg: { tools }, sandboxMode: 'off' });
const allowed = policies.every(policy => match(policy)('${OpenClawToolName.COMPUTER}'));
process.stdout.write('${OUTPUT_PREFIX}' + JSON.stringify(allowed));
`;

type PolicyRunner = (runtimeRoot: string, input: string) => Promise<string>;

const runNativePolicy: PolicyRunner = (runtimeRoot, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', POLICY_SCRIPT, runtimeRoot],
      {
        cwd: runtimeRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) {
        child.kill();
        reject(new Error('Native computer policy unavailable'));
      } else resolve(output);
    };
    const timer = setTimeout(() => finish(true), POLICY_TIMEOUT_MS);
    child.on('error', () => finish(true));
    child.stdin.on('error', () => finish(true));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) finish(true);
      else output += chunk.toString('utf8');
    });
    child.on('close', code => finish(code !== 0));
    child.stdin.end(input);
  });

/** Project only the global settings choice; native execution still enforces all session policies. */
export async function evaluateComputerControlNativePolicy(
  runtimeRoot: string | null,
  tools: Record<string, unknown>,
  run: PolicyRunner = runNativePolicy,
): Promise<boolean> {
  if (!runtimeRoot) throw new Error('Native computer policy unavailable');
  // Other tools fields may contain endpoint credentials. Only policy fields leave Main.
  const policy: Record<string, unknown> = {};
  for (const key of ['allow', 'alsoAllow', 'deny'] as const) {
    if (Array.isArray(tools[key])) {
      policy[key] = tools[key].filter((value): value is string => typeof value === 'string');
    }
  }
  if (typeof tools.profile === 'string') policy.profile = tools.profile;
  const input = JSON.stringify(policy);
  if (Buffer.byteLength(input) > MAX_POLICY_BYTES) throw new Error('Computer policy too large');
  const output = await run(runtimeRoot, input);
  if (output === `${OUTPUT_PREFIX}true`) return true;
  if (output === `${OUTPUT_PREFIX}false`) return false;
  throw new Error('Native computer policy unavailable');
}
