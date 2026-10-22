/** Shared display text for native progress_card receipts, independent of execution ownership. */
export function projectProgressReceipt(tool: { input?: unknown; status?: string }) {
  const input =
    tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
      ? (tool.input as Record<string, unknown>)
      : null;
  const plan = Array.isArray(input?.plan) ? input.plan : [];
  const steps = plan.flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const { step, status } = candidate as Record<string, unknown>;
    if (
      typeof step !== 'string' ||
      (status !== 'pending' && status !== 'in_progress' && status !== 'completed')
    )
      return [];
    return [{ step: step.trim(), status }];
  });
  const completed = steps.filter(step => step.status === 'completed').length;
  const current =
    steps.find(step => step.status === 'in_progress') ??
    steps.find(step => step.status === 'pending') ??
    [...steps].reverse().find(step => step.status === 'completed');
  const markdown = typeof input?.markdown === 'string' ? input.markdown.trim() : '';
  const key =
    tool.status === 'running' || tool.status === 'inProgress'
      ? 'coworkProgressReceiptUpdating'
      : tool.status === 'failed'
        ? 'coworkProgressReceiptFailed'
        : tool.status === 'cancelled' || tool.status === 'interrupted'
          ? 'coworkProgressReceiptInterrupted'
          : steps.length > 0
            ? 'coworkProgressReceiptUpdated'
            : markdown
              ? 'coworkProgressReceiptNoteUpdated'
              : input
                ? 'coworkProgressReceiptCleared'
                : 'coworkProgressReceiptChanged';
  return {
    key,
    values: {
      completed: String(completed),
      total: String(steps.length),
      current: current?.step ?? '',
    },
  };
}
