import type { SwarmWorkflowNode } from '../../contracts/workflow';

export function layoutFlow(nodes: SwarmWorkflowNode[], columns = 3) {
  const levels = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++)
    for (const node of nodes) {
      if (!levels.has(node.id) && node.deps.every(d => levels.has(d)))
        levels.set(
          node.id,
          node.deps.length ? Math.max(...node.deps.map(d => levels.get(d)!)) + 1 : 0,
        );
    }
  const rows = new Map<number, SwarmWorkflowNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? nodes.length;
    const row = rows.get(level) ?? [];
    row.push(node);
    rows.set(level, row);
  }
  // Size the graph to its widest row, and center every partial row on that axis.
  const count = Math.max(
    1,
    Math.min(columns, Math.max(0, ...[...rows.values()].map(row => row.length))),
  );
  const width = count * 190 + 30;
  const points = new Map<string, { x: number; y: number }>();
  let y = 35;
  for (const [, row] of [...rows].sort(([a], [b]) => a - b)) {
    row.forEach((node, i) => {
      const rowCount = Math.min(count, row.length - Math.floor(i / count) * count);
      const left = (width - ((rowCount - 1) * 190 + 160)) / 2;
      points.set(node.id, { x: left + (i % count) * 190, y: y + Math.floor(i / count) * 132 });
    });
    y += Math.ceil(row.length / count) * 132;
  }
  return { points, height: y + 20, width, nodes };
}
export function routeFlowEdge(
  layout: ReturnType<typeof layoutFlow>,
  sourceId: string,
  targetId: string,
) {
  const source = layout.points.get(sourceId);
  const target = layout.points.get(targetId);
  if (!source || !target) return [];
  const start = { x: source.x + 80, y: source.y + 72 };
  const end = { x: target.x + 80, y: target.y };
  // Direct connections avoid boxed elbows between adjacent parallel stages.
  if (target.y - source.y <= 132) return [start, end];
  // Skip intervening rows outside the cards, including wrapped parallel rows.
  const lane = start.x <= layout.width / 2 ? 10 : layout.width - 10;
  return [
    start,
    { x: start.x, y: start.y + 12 },
    { x: lane, y: start.y + 12 },
    { x: lane, y: end.y - 14 },
    { x: end.x, y: end.y - 14 },
    end,
  ];
}

export function edgePath(points: Array<{ x: number; y: number }>) {
  return points
    .map((point, index) => (index === 0 ? `M ${point.x} ${point.y}` : `L ${point.x} ${point.y}`))
    .join(' ');
}
