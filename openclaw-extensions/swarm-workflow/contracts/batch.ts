import type { Flow, FlowNode, NodeStatus } from './flow.js';

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
// Conservative fallback when the public model-call event has no budget evidence.
// Cost includes both copies in the tool envelope and worst-case text weights.
export const RESULT_PAGE_TRANSPORT_BUDGET = 2000;
/** Use the exact delivered envelope when selecting a result page. */
export function batchResultPage(
  flow: Pick<Flow, 'id'>,
  stage: Pick<FlowNode, 'id' | 'batchInput' | 'batchCounts'>,
  items: unknown[],
  after?: number,
) {
  return {
    flowId: flow.id,
    stageId: stage.id,
    manifestVersion: stage.batchInput?.version,
    total: stage.batchCounts?.total,
    items,
    ...(after === undefined
      ? {}
      : {
          cursor: Buffer.from(
            JSON.stringify([flow.id, stage.id, stage.batchInput?.version, after]),
          ).toString('base64url'),
        }),
  };
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
