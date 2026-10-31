import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

const COMMAND_RESULT_GUIDANCE = [
  'Result collection for OpenClaw native shell exec and Code Mode exec, when these tools are available:',
  'Automatic command-exit wake-ups for these native tools are disabled. For ordinary commands and programs whose results are needed to finish the current task, use awaitResults: true.',
  'If a call already returned running or waiting, collect its terminal result using the existing process or cell handle before ending the task, unless an explicit separate continuation is arranged. Do not launch the command again to collect its result.',
  'Reserve background: true for independent services that need to keep running. Verify service readiness before reporting success; do not wait for such a service to exit merely to finish the task.',
].join('\n');

/** Stable guidance complements native manual-collection notices; it is not a terminal gate. */
export function registerCommandResultPolicy(api: OpenClawPluginApi): void {
  api.on('before_prompt_build', (_event, ctx) => {
    const runtime = ctx.agentId ? api.config?.agents?.entries?.[ctx.agentId]?.runtime : undefined;
    if (runtime?.type === 'acp') return;
    return { appendSystemContext: COMMAND_RESULT_GUIDANCE };
  });
}
