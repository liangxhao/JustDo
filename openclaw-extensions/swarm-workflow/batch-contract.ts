import type { FlowNode, NodeStatus } from './contract.js';

export type BatchSource =
  { kind: 'files'; path: string; pattern?: string } | { kind: 'jsonl'; path: string };
export type BatchPlan = { source: BatchSource };
export type FrozenFile = {
  source: string;
  relativePath: string;
  path: string;
  bytes: number;
  sha256: string;
};
export type FrozenInput = {
  id: string;
  ordinal: number;
  key: string;
  title: string;
  data?: Record<string, unknown>;
  files: FrozenFile[];
};
export type BatchManifest = {
  version: string;
  createdAt: number;
  root: string;
  bytes: number;
  projectRules: string;
  rulesOrigin: string;
  rulesVersion: string;
  inputs: FrozenInput[];
};
export type BatchItemIdentity = {
  stageId: string;
  manifestVersion: string;
  ordinal: number;
  key: string;
  workspace: string;
};
export type BatchCounts = Record<NodeStatus, number> & { total: number };
export type BatchItemView = Pick<
  FlowNode,
  | 'id'
  | 'title'
  | 'agentId'
  | 'agentName'
  | 'status'
  | 'attempt'
  | 'startedAt'
  | 'endedAt'
  | 'error'
>;
export type BatchPage = {
  flowId: string;
  stageId: string;
  manifestVersion: string;
  revision: number;
  counts: BatchCounts;
  matched: number;
  retryable: number;
  items: BatchItemView[];
  cursor?: string;
};
export type ResultArtifact = {
  path: string;
  bytes: number;
  sha256: string;
};
export type ItemResultManifest = {
  flowId: string;
  stageId: string;
  itemId: string;
  manifestVersion: string;
  attempt: number;
  runId: string;
  inputKey: string;
  summary: string;
  artifacts: ResultArtifact[];
};
export const BATCH_LIMITS = {
  page: 50,
  resultPage: 20,
  resultPageBytes: 32768,
  summary: 512,
  envelopeBytes: 24576,
} as const;

// Deferred tool_call serializes both details and content. Fit its complete,
// pretty-printed envelope below the native 16,000-character producer cap.
export const RESULT_TRANSPORT_BYTES = 12000;
export function resultTransportBudget(contextTokens?: number): number {
  // Native prompt admission also counts ASCII with a minimum raw weight of
  // two. Reserving half the effective context covers that independent guard.
  const tokens = Number.isFinite(contextTokens) && contextTokens! > 0 ? contextTokens! : 4000;
  return Math.min(RESULT_TRANSPORT_BYTES, Math.floor(tokens / 2));
}
export function resultTransportBytes(value: unknown): number {
  return Buffer.byteLength(resultTransportText(value));
}
export function resultTransportCost(value: unknown): number {
  const text = resultTransportText(value);
  // The native producer counts rare CJK characters at up to 16 units per
  // code point. Conservatively cover that maximum without relying on a
  // model-specific tokenizer or treating UTF-8 bytes as context cost.
  let characters = 0;
  for (const character of text) characters += character.codePointAt(0)! > 127 ? 16 : 1;
  return Math.max(Buffer.byteLength(text), characters);
}
function resultTransportText(value: unknown): string {
  return JSON.stringify(
    {
      tool: {
        id: 'openclaw:swarm-workflow:swarm_workflow_results',
        name: 'swarm_workflow_results',
        source: 'openclaw',
      },
      result: { details: value, content: [{ type: 'text', text: JSON.stringify(value) }] },
    },
    null,
    2,
  );
}
