export function createNestedToolActivity(index = 1, isError = false) {
  return {
    role: 'custom',
    customType: 'openclaw.nested-tool.v1',
    display: true,
    excludeFromContext: true,
    content: '',
    timestamp: 1_000 + index,
    details: {
      runId: 'native-run',
      scopeId: 'native-scope',
      afterEntryId: `assistant-${index}`,
      startOrder: index,
      parentToolCallId: `outer-${index}`,
      toolCallId: `nested-${index}`,
      toolName: 'browser',
      input: { action: 'text', targetId: `tab-${index}` },
      result: {
        content: [{ type: 'text', text: isError ? 'Page unavailable' : `News page ${index}` }],
        details: {
          browserTab: { targetId: `tab-${index}`, profile: 'embedded', target: 'host' },
          durationMs: 12,
        },
      },
      isError,
      startedAt: 1_000 + index,
      timestamp: 1_100 + index,
    },
  };
}
