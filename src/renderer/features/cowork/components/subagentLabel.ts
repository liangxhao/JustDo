type SubagentLabelIdentity = {
  sessionKey: string;
};

const INTERNAL_SUBAGENT_LABEL_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f-]{27})?(?: \(\d{4}-\d{2}-\d{2}\))?$/i;

export const isInternalSubagentLabel = (
  subagent: SubagentLabelIdentity,
  label: string,
): boolean => {
  const normalizedLabel = label.trim();
  const sessionSegments = subagent.sessionKey.split(':');
  const sessionSuffix = sessionSegments[sessionSegments.length - 1];

  return (
    normalizedLabel === '' ||
    normalizedLabel === sessionSuffix ||
    normalizedLabel === subagent.sessionKey ||
    INTERNAL_SUBAGENT_LABEL_PATTERN.test(normalizedLabel)
  );
};

export const reconcileSubagentLabel = (
  subagent: SubagentLabelIdentity,
  previousLabel: string | undefined,
  incomingLabel: string,
): string => {
  if (!previousLabel || isInternalSubagentLabel(subagent, previousLabel)) {
    return incomingLabel;
  }
  return previousLabel;
};
