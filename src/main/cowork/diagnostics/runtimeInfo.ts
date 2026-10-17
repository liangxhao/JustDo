import fs from 'node:fs/promises';
import path from 'node:path';

import { projectDiagnosticRuntimeArtifact } from '../../../shared/cowork/diagnostics/diagnosticRuntimeInfo';
import type { DiagnosticRuntimeArtifact } from '../../../shared/cowork/diagnostics/sessionDiagnostics';

/** Read only bounded build metadata at the Main-owned installed runtime root. */
export async function readDiagnosticRuntimeArtifact(
  root: string | null,
  signal?: AbortSignal,
): Promise<DiagnosticRuntimeArtifact | undefined> {
  if (!root || signal?.aborted) return;
  const readSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(3000)])
    : AbortSignal.timeout(3000);
  let onAbort: (() => void) | undefined;
  try {
    const read = async () => {
      const handle = await fs.open(path.join(root, 'runtime-build-info.json'), 'r');
      try {
        readSignal.throwIfAborted();
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 65536) return;
        const buffer = Buffer.alloc(65537);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        readSignal.throwIfAborted();
        if (bytesRead > 65536 || bytesRead < stat.size) return;
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        // A late OS read still closes its own handle after the caller times out.
        await handle.close();
      }
    };
    const build = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('canceled'));
        readSignal.addEventListener('abort', onAbort, { once: true });
        if (readSignal.aborted) onAbort();
      }),
    ]);
    if (!build) return;
    return projectDiagnosticRuntimeArtifact({
      version: build?.openclawVersion,
      patchSetSha256: build?.patchSetSha256,
      buildRecipeSha256: build?.buildRecipeSha256,
      gatewayAsarSha256: build?.gatewayAsarSha256,
    });
  } catch {
    return undefined;
  } finally {
    if (onAbort) readSignal.removeEventListener('abort', onAbort);
  }
}
