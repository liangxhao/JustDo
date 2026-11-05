import {
  AppServerErrorCode,
  type AppServerParams,
  AppServerRpcError,
  isAppServerRecord,
} from './appServerProtocol';

function invalid(field: string): never {
  throw new AppServerRpcError(AppServerErrorCode.InvalidParams, `Invalid ${field}.`);
}

const validClientName = (value: unknown): value is string =>
  typeof value === 'string' && [...value].every(character => {
    const code = character.charCodeAt(0);
    return code === 9 || (code >= 32 && code !== 127);
  });

/** Validate before committing initialize state; client declarations never grant capabilities. */
export function validateCodexInitialize(params: AppServerParams): void {
  const client = params.clientInfo;
  if (!isAppServerRecord(client)) invalid('clientInfo');
  if (!validClientName(client.name)) invalid('clientInfo.name');
  if (typeof client.version !== 'string') invalid('clientInfo.version');
  if (client.title != null && typeof client.title !== 'string') invalid('clientInfo.title');

  const capabilities = params.capabilities;
  if (capabilities == null) return;
  if (!isAppServerRecord(capabilities)) invalid('capabilities');
  for (const field of [
    'experimentalApi',
    'requestAttestation',
    'explicitGatewayOauth',
    'mcpServerOpenaiFormElicitation',
  ]) {
    if (capabilities[field] !== undefined && typeof capabilities[field] !== 'boolean')
      invalid(`capabilities.${field}`);
  }
  const optOut = capabilities.optOutNotificationMethods;
  if (optOut != null && (!Array.isArray(optOut) || optOut.some(value => typeof value !== 'string')))
    invalid('capabilities.optOutNotificationMethods');
  if (capabilities.extensions != null && !isAppServerRecord(capabilities.extensions))
    invalid('capabilities.extensions');
}
