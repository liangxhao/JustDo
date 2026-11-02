import { type ChildProcess, spawn, type SpawnOptions } from 'child_process';

const COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_OUTPUT_CHARS = 64_000;
const SUCCESS_TERMINATION_DELAY_MS = 250;
const TERMINATION_ESCALATION_DELAY_MS = 2_000;
const EXIT_OUTPUT_FLUSH_DELAY_MS = 50;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Main-only native receipt evidence; it does not establish process settlement. */
  nativeReceiptObserved?: true;
};

export type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (output: string) => void;
  successPattern?: RegExp;
};

type CommandDependencies = {
  spawn?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
};

/** Keep the caller's mutation guards held until the actual CLI process has exited. */
export const runExtensionCommand = (
  executable: string,
  args: string[],
  options: CommandOptions,
  dependencies: CommandDependencies = {},
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const spawnCommand = dependencies.spawn ?? spawn;
    const platform = dependencies.platform ?? process.platform;
    const { onOutput, successPattern, ...spawnOptions } = options;
    const child = spawnCommand(executable, args, {
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let outputFlushed = false;
    let settled = false;
    let exited = false;
    let spawned = child.pid !== undefined;
    let timedOut = false;
    let successObserved = false;
    const windowsSuccessTerminations: Promise<boolean>[] = [];
    const requestedSuccessSignals = new Set<NodeJS.Signals>();
    let timeout: NodeJS.Timeout | undefined;
    let successTerminationTimer: NodeJS.Timeout | undefined;
    let terminationEscalationTimer: NodeJS.Timeout | undefined;
    const clearCommandTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (successTerminationTimer) clearTimeout(successTerminationTimer);
      if (terminationEscalationTimer) clearTimeout(terminationEscalationTimer);
    };
    const requestTermination = (force: boolean, afterSuccess = false) => {
      if (exited || settled || child.pid === undefined) return;
      try {
        if (platform === 'win32') {
          const termination = new Promise<boolean>(resolveTermination => {
            try {
              const killer = spawnCommand('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
              });
              // Helper outcomes classify cleanup only, never target settlement.
              killer.on('error', () => resolveTermination(false));
              killer.once('exit', code => resolveTermination(code === 0));
            } catch {
              resolveTermination(false);
            }
          });
          if (afterSuccess) windowsSuccessTerminations.push(termination);
        } else {
          const signal = force ? 'SIGKILL' : 'SIGTERM';
          if (child.kill(signal) && afterSuccess) requestedSuccessSignals.add(signal);
        }
      } catch {
        // A failed termination request must retain the caller's mutation guards.
      }
    };
    const inspectSuccessfulOutput = () => {
      if (timedOut || settled || successObserved || !successPattern?.test(stdout)) return;
      successObserved = true;
      if (exited) return;
      // A final native receipt can leave shared-state handles open. Stop the CLI,
      // but keep its stopped-Gateway lease until the target's own exit arrives.
      successTerminationTimer = setTimeout(() => {
        if (exited || settled || timedOut || child.pid === undefined) return;
        requestTermination(false, true);
        terminationEscalationTimer = setTimeout(() => {
          requestTermination(true, true);
        }, TERMINATION_ESCALATION_DELAY_MS);
      }, SUCCESS_TERMINATION_DELAY_MS);
    };
    child.stdout?.on('data', chunk => {
      if (settled || outputFlushed) return;
      const output = String(chunk);
      stdout = `${stdout}${output}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
      onOutput?.(output);
      inspectSuccessfulOutput();
    });
    child.stderr?.on('data', chunk => {
      if (settled || outputFlushed) return;
      const output = String(chunk);
      stderr = `${stderr}${output}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
      onOutput?.(output);
    });
    child.once('spawn', () => {
      spawned = true;
    });
    child.on('error', error => {
      if (settled || exited || spawned || child.pid !== undefined) return;
      // With no spawn event and no PID, the command never acquired a process.
      settled = true;
      clearCommandTimers();
      reject(error);
    });
    // Use `exit`, not `close`: npm descendants may inherit the output pipes and
    // keep `close` pending after the OpenClaw process has already exited.
    child.once('exit', (code, signal) => {
      exited = true;
      clearCommandTimers();
      if (settled) return;
      const cleanupConfirmed = platform === 'win32'
        ? timedOut || code === 0
          ? Promise.resolve(false)
          : new Promise<boolean>(confirmCleanup => {
              let remaining = windowsSuccessTerminations.length;
              if (remaining === 0) confirmCleanup(false);
              for (const termination of windowsSuccessTerminations) {
                void termination.then(success => {
                  remaining -= 1;
                  if (success || remaining === 0) confirmCleanup(success);
                });
              }
            })
        : Promise.resolve(code === null && signal !== null && requestedSuccessSignals.has(signal));
      const outputReady = new Promise<void>(flush => {
        setTimeout(() => {
          outputFlushed = true;
          flush();
        }, EXIT_OUTPUT_FLUSH_DELAY_MS);
      });
      // taskkill can finish draining descendants after the target exits. Its
      // outcome must not depend on the separate output-flush timer's ordering.
      void Promise.all([outputReady, cleanupConfirmed]).then(([, terminatedAfterSuccess]) => {
        settled = true;
        // A receipt followed by a failed kill must not erase a real native error.
        // Normalize only an observed exit attributable to our successful cleanup.
        resolve({
          exitCode: timedOut ? 124 : terminatedAfterSuccess ? 0 : (code ?? 1),
          stdout,
          stderr,
          ...(timedOut ? { timedOut: true } : {}),
          ...(successObserved ? { nativeReceiptObserved: true as const } : {}),
        });
      });
    });
    timeout = setTimeout(() => {
      timedOut = true;
      if (successTerminationTimer) clearTimeout(successTerminationTimer);
      if (terminationEscalationTimer) clearTimeout(terminationEscalationTimer);
      requestTermination(true);
      // A deadline is not exit evidence. A late receipt cannot reverse this
      // timeout, and an unexited target keeps the existing mutation guards held.
    }, COMMAND_TIMEOUT_MS);
  });
