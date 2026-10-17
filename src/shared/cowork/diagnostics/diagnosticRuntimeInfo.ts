import type { DiagnosticGatewayInfo, DiagnosticRuntimeArtifact } from './sessionDiagnostics';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const version = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length <= 64 &&
  /^v?\d+(?:\.\d+){1,3}(?:-(?:\d+|(?:alpha|beta|rc|dev)(?:[.-]\d+)?))?$/.test(value)
    ? value
    : undefined;
const digest = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f\d]{64}$/i.test(value) ? value.toLowerCase() : undefined;

/** Handshake projection excludes auth, connection IDs and arbitrary server metadata. */
export function projectDiagnosticGatewayInfo(value: unknown): DiagnosticGatewayInfo {
  const hello = object(value);
  const server = object(hello.server);
  return {
    version: version(server.version),
    protocol:
      Number.isSafeInteger(hello.protocol) && (hello.protocol as number) > 0
        ? (hello.protocol as number)
        : undefined,
    buildId:
      typeof server.buildId === 'string' && /^[a-f\d]{7,64}$/i.test(server.buildId)
        ? server.buildId.toLowerCase()
        : undefined,
  };
}

/** Also used during export; never spread filesystem or RPC metadata into reports. */
export function projectDiagnosticRuntimeArtifact(value: unknown): DiagnosticRuntimeArtifact {
  const artifact = object(value);
  return {
    version: version(artifact.version),
    patchSetSha256: digest(artifact.patchSetSha256),
    buildRecipeSha256: digest(artifact.buildRecipeSha256),
    gatewayAsarSha256: digest(artifact.gatewayAsarSha256),
  };
}
