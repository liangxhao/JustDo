export type SubagentLabelSource = 'taskName' | 'label' | 'task';

type SubagentLabelSnapshot = {
  label: string;
  labelSource: SubagentLabelSource;
};

const LABEL_SOURCE_PRIORITY: Record<SubagentLabelSource, number> = {
  label: 0,
  task: 1,
  taskName: 2,
};

export const reconcileSubagentLabel = (
  previous: SubagentLabelSnapshot | undefined,
  incoming: SubagentLabelSnapshot,
): SubagentLabelSnapshot => {
  if (
    !previous ||
    LABEL_SOURCE_PRIORITY[incoming.labelSource] <= LABEL_SOURCE_PRIORITY[previous.labelSource]
  ) {
    return incoming;
  }
  return previous;
};
