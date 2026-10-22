import { type ChildProcess, spawn } from 'child_process';

import { nativeHistoryError } from './historyFailure';
import { NATIVE_HISTORY_VERIFICATION_SOURCE } from './nativeHistoryVerification';

export type NativeHistoryOperation = 'import' | 'inspect' | 'verify';
type RuntimeEnvironment = { env: NodeJS.ProcessEnv; runtimeRoot: string; openclawEntry: string };

/** An offline startup owner, separate from the live Gateway and generic Doctor UI. */
export class NativeHistoryRuntime {
  private child: ChildProcess | null = null;
  private operation: Promise<string> | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      getEnvironment: () => Promise<RuntimeEnvironment>;
      gatewayStopped: () => boolean;
      stateDir: () => string;
      executable?: string;
    },
  ) {}

  run(mode: NativeHistoryOperation, planFile?: string): Promise<string> {
    if (this.operation)
      return Promise.reject(new Error('Another native history operation is active.'));
    const operation = this.execute(mode, planFile).finally(() => {
      this.child = null;
      this.operation = null;
    });
    this.operation = operation;
    return operation;
  }

  private async execute(mode: NativeHistoryOperation, planFile?: string): Promise<string> {
    if (this.stopped || !this.deps.gatewayStopped())
      throw new Error('History restoration requires a stopped Gateway.');
    const cli = await this.deps.getEnvironment();
    if (this.stopped || !this.deps.gatewayStopped())
      throw new Error('History startup admission changed.');
    if (mode === 'verify' && !planFile)
      throw new Error('The history verification plan is missing.');
    const args =
      mode === 'verify'
        ? [
            '--input-type=module',
            '-e',
            NATIVE_HISTORY_VERIFICATION_SOURCE,
            cli.runtimeRoot,
            this.deps.stateDir(),
            planFile!,
          ]
        : [
            cli.openclawEntry,
            'doctor',
            '--session-sqlite',
            mode,
            '--session-sqlite-all-agents',
            '--json',
          ];
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.deps.executable ?? process.execPath, args, {
        cwd: cli.runtimeRoot,
        env: { ...cli.env, ELECTRON_RUN_AS_NODE: '1', OPENCLAW_NO_RESPAWN: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      let failure: Error | null = null;
      const append = (stream: 'stdout' | 'stderr', chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) {
          failure = new Error('Native history verification produced too much output.');
          child.kill();
          return;
        }
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout!.setEncoding('utf8').on('data', chunk => append('stdout', chunk));
      child.stderr!.setEncoding('utf8').on('data', chunk => append('stderr', chunk));
      child.once('error', error => {
        failure = error;
      });
      // Wait for process retirement, including during Quit. Unknown import outcomes
      // keep their journal stage and are reconciled by the native importer next time.
      child.once('close', code => {
        if (this.stopped) reject(new Error('History startup was interrupted.'));
        else if (failure) reject(failure);
        else if (code !== 0)
          reject(
            nativeHistoryError(
              `Native history ${mode} failed: ${(stderr.trim() || `exit ${code}`).slice(0, 800)}`,
              stdout,
              stderr,
            ),
          );
        else {
          try {
            JSON.parse(stdout);
            resolve(stdout);
          } catch (error) {
            reject(error);
          }
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill();
    await this.operation?.catch((): void => {});
  }
}
