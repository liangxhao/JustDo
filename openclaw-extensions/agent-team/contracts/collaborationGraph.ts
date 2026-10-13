import {
  type CollaborationDelivery,
  CollaborationDeliveryState,
  type CollaborationRoom,
} from './collaboration';

export interface CollaborationEdge {
  from: string;
  to: string;
  deliveries: CollaborationDelivery[];
  accepted: number;
  pending: number;
  failed: number;
  unknown: number;
}

/** An event projection, never an interpretation of model prose or a subtask tree. */
export function buildCollaborationEdges(
  room: CollaborationRoom,
  deliveries: readonly CollaborationDelivery[],
): CollaborationEdge[] {
  const members = new Set(room.members.map(member => member.agentId));
  const latest = new Map<string, CollaborationDelivery>();
  for (const delivery of deliveries) {
    if (
      delivery.roomId !== room.id ||
      delivery.from === delivery.to ||
      !members.has(delivery.from) ||
      !members.has(delivery.to)
    )
      continue;
    const previous = latest.get(delivery.id);
    if (!previous || delivery.updatedAt > previous.updatedAt) latest.set(delivery.id, delivery);
  }
  const edges = new Map<string, CollaborationEdge>();
  for (const delivery of [...latest.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  )) {
    const key = `${delivery.from}:${delivery.to}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = {
        from: delivery.from,
        to: delivery.to,
        deliveries: [],
        accepted: 0,
        pending: 0,
        failed: 0,
        unknown: 0,
      };
      edges.set(key, edge);
    }
    edge.deliveries.push(delivery);
    if (delivery.state === CollaborationDeliveryState.ACCEPTED) edge.accepted++;
    else if (delivery.state === CollaborationDeliveryState.FAILED) edge.failed++;
    else if (delivery.state === CollaborationDeliveryState.UNKNOWN) edge.unknown++;
    else edge.pending++;
  }
  return [...edges.values()];
}
