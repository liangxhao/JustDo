export interface AppPluginTypecheckOptions {
  sourceRoot?: string;
  openclawSdkRoot?: string;
}
export function typecheckAppPlugin(
  source: string,
  options?: AppPluginTypecheckOptions,
): Promise<{ id: string }>;
export function typecheckAppPlugins(options?: AppPluginTypecheckOptions): Promise<{ id: string }[]>;
