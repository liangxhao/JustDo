import { SwarmWorkflowMode, type SwarmWorkflowOptions } from '../contracts/options';

export function buildSwarmWorkflowInstruction(options: SwarmWorkflowOptions): string {
  return `<swarm-workflow mode="${options.mode}"/>`;
}

export function parseSwarmWorkflowRequest(text: string) {
  for (const mode of Object.values(SwarmWorkflowMode)) {
    const suffix = '\n\n' + buildSwarmWorkflowInstruction({ mode, verify: true });
    if (text.endsWith(suffix)) return { mode, request: text.slice(0, -suffix.length) };
  }
  return undefined;
}

// Match only the exact current workflow suffix; there are no historical aliases.
export function stripSwarmWorkflowInstruction(text: string): string {
  return parseSwarmWorkflowRequest(text)?.request ?? text;
}
