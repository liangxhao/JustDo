import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_VERSION = '2026.10.7';
const REQUIRED_FILES = [
  'dist/builtin-openclaw-Ci5YBsOb.mjs',
  'dist/server-chat-state-go3yND5C.mjs',
  'dist/server-chat-qsqHPdkU.mjs',
  'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-CpOy9-IQ.mjs',
  'node_modules/@openclaw/ai/dist/internal/openai.mjs',
] as const;

function admitReasoningRuntime(candidate: string): string {
  try {
    const root = fs.realpathSync(candidate);
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (metadata.name !== 'openclaw' || metadata.version !== RUNTIME_VERSION) {
      throw new Error(`Expected openclaw@${RUNTIME_VERSION}, received ${metadata.name}@${metadata.version}`);
    }
    for (const file of REQUIRED_FILES) {
      if (!fs.statSync(path.join(root, file)).isFile()) {
        throw new Error(`Required native reasoning owner is not a file: ${file}`);
      }
    }
    const ai = path.join(root, 'node_modules/@openclaw/ai/dist');
    const files = fs.readdirSync(ai);
    const transports = files.filter(name => /^openai-completions-transport-.*\.mjs$/u.test(name));
    const hosts = files.filter(name => /^host-.*\.mjs$/u.test(name) &&
      fs.readFileSync(path.join(ai, name), 'utf8').includes('function createAiTransportHost('));
    if (transports.length !== 1 || hosts.length !== 1) {
      throw new Error('Expected one native completions transport and one AI transport host.');
    }
    return root;
  } catch (error) {
    throw new Error(`Native reasoning runtime admission failed: ${candidate}`, { cause: error });
  }
}

/** Presence selects a target; a stale or incomplete selected artifact must fail. */
export function resolveReasoningRuntime({
  repositoryRoot = process.cwd(),
  environment = process.env,
}: {
  repositoryRoot?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): string {
  const requested = environment.JUSTDO_EXECUTION_PRISTINE_DIR ?? environment.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
  if (requested !== undefined) return admitReasoningRuntime(path.resolve(repositoryRoot, requested));
  const candidates = [
    path.join(repositoryRoot, 'build/runtimes/openclaw/win-x64'),
    path.join(repositoryRoot, 'vendor/openclaw-runtime/current'),
  ];
  const selected = candidates.find(candidate => fs.existsSync(candidate));
  if (!selected) {
    throw new Error(
      `Native reasoning tests require a prepared openclaw@${RUNTIME_VERSION} runtime. ` +
      'Prepare the locked runtime or set JUSTDO_EXECUTION_PRISTINE_DIR or OPENCLAW_TEST_NATIVE_RUNTIME_DIR.',
    );
  }
  return admitReasoningRuntime(selected);
}
