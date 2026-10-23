// OpenClaw 2026.10.4 exports this public facade without its declaration file.
// Keep only the consumed signatures, verified against the locked SDK sources.
declare module 'openclaw/plugin-sdk/process-runtime' {
  export function isPidDefinitelyDead(pid: number): boolean;
  export function signalProcessTree(
    pid: number,
    signal: 'SIGTERM' | 'SIGKILL',
    options?: { detached?: boolean; onComplete?: () => void },
  ): void;
}
