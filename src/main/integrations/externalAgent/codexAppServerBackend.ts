import path from 'node:path';

import { prepareCodexSessionMarker } from './codexSessionMarker';
import type { ExternalAgentBackend } from './externalAgentTypes';

export type CodexAppServerBackend = Omit<ExternalAgentBackend, 'start'> & {
  start(params: { cwd?: string; model?: string }): ReturnType<ExternalAgentBackend['start']>;
};

/** Codex wire defaults over the same authenticated product sessions used by CLI and ACP. */
export function createCodexAppServerBackend(
  backend: ExternalAgentBackend,
  options: { cwd: string; codexHome?: string },
): CodexAppServerBackend {
  const marker = () =>
    options.codexHome === undefined ? undefined : prepareCodexSessionMarker(options.codexHome);
  return {
    models: () => backend.models(),
    start: async params => {
      const onCreated = marker();
      return backend.start({
        cwd: path.resolve(options.cwd, params.cwd ?? '.'),
        model: params.model,
        ...(onCreated ? { onCreated } : {}),
      });
    },
    resume: async (id, params) => {
      const writeMarker = marker();
      const thread = await backend.resume(id, {
        ...(params.cwd ? { cwd: path.resolve(options.cwd, params.cwd) } : {}),
        model: params.model,
      });
      writeMarker?.(thread);
      return thread;
    },
    run: (...args) => backend.run(...args),
  };
}
