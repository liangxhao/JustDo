export function handoffContent(message: string, sourceId: string) {
  try {
    const value = JSON.parse(message);
    const input = Array.isArray(value?.inputs)
      ? value.inputs.find((item: { id?: string } | null) => item?.id === sourceId)
      : undefined;
    if (typeof value?.assignedTask !== 'string' || typeof input?.result !== 'string')
      return undefined;
    return { result: input.result as string, task: value.assignedTask as string };
  } catch {
    return undefined;
  }
}
