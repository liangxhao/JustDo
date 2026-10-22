export const expandBundledAgentCommandValue = (
  value: string,
  paths: { nodeExecutable: string; pluginRoot: string; openClawRoot: string },
): string =>
  value
    .replaceAll('${NODE_EXECUTABLE}', paths.nodeExecutable)
    .replaceAll('${ACPX_PLUGIN_ROOT}', paths.pluginRoot)
    .replaceAll('${OPENCLAW_ROOT}', paths.openClawRoot);
