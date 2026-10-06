import { createHash } from 'node:crypto';
import type { Flow, FlowNode } from './contract.js';
import { RESULT_TRANSPORT_BYTES, resultTransportCost } from './batch-contract.js';

/** Paged business results only. Native transcript custody is unchanged. */
export function resultPage(
  flow: Flow,
  reader: FlowNode,
  nodeId: string,
  cursor?: string,
  transportBudget = RESULT_TRANSPORT_BYTES,
) {
  const source = flow.nodes.find(
    node => node.id === nodeId && !node.batchItem && node.kind !== 'batch',
  );
  if (
    !source ||
    source.status !== 'done' ||
    !source.result ||
    (reader.kind !== 'verify' && !reader.deps.includes(nodeId)) ||
    (reader.kind === 'verify' && source.kind !== 'work')
  )
    throw new Error('Result is not an accepted dependency of this node.');
  const identity = [
    flow.id,
    source.id,
    source.attempt ?? 1,
    source.runId ?? source.intendedRunId,
    createHash('sha256').update(source.result).digest('hex'),
  ];
  let offset = 0;
  if (cursor) {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 6 ||
      identity.some((value, index) => parsed[index] !== value) ||
      !Number.isSafeInteger(parsed[5]) ||
      parsed[5] < 0 ||
      parsed[5] >= source.result.length
    )
      throw new Error('Result cursor belongs to another accepted attempt.');
    offset = parsed[5];
  }
  let length = Math.min(source.result.length - offset, 2048);
  while (length > 0) {
    let end = offset + length;
    if (end < source.result.length && /[\uD800-\uDBFF]/.test(source.result[end - 1])) end--;
    if (end > offset) {
      const page = {
        flowId: flow.id,
        nodeId,
        format: 'text-fragment',
        totalCharacters: source.result.length,
        offset,
        text: source.result.slice(offset, end),
        ...(end < source.result.length
          ? { cursor: Buffer.from(JSON.stringify([...identity, end])).toString('base64url') }
          : {}),
      };
      if (resultTransportCost(page) <= transportBudget) return page;
    }
    length = Math.floor(length / 2);
  }
  throw new Error('Result fragment identity exceeds its transport budget.');
}
