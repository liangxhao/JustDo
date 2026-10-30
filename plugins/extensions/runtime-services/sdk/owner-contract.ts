export const OWNER_BINDING_METHOD = 'runtimeServices.ownerBinding';
export const OWNER_PROOF_BRIDGE_KEY = 'runtime-services.owner-proof.v1';

export interface VerifiedOwner {
  readonly pluginId: string;
  readonly registrationId: string;
  isCurrent(): boolean;
  assertCurrent(): void;
  onRetire(cleanup: () => void): () => void;
}
export interface OwnerWriteLease extends VerifiedOwner {
  readonly token: string;
  readonly providerScope: string;
}
export interface OwnerProvider {
  readonly scope: string;
  resolve(token: string): VerifiedOwner | undefined;
  dispose(): void;
}
export interface OwnerClient {
  /** Only the proof handshake is retriable. This never invokes business work. */
  bind(): Promise<boolean>;
  /** Share one read-only initial binding across capability clients using the same native API. */
  ensureBound(): Promise<boolean>;
  captureLease(): OwnerWriteLease | undefined;
  dispose(): void;
}
export interface OwnerNativeLifecycle {
  signal?: AbortSignal;
  onDispose?: (cleanup: () => void) => () => void;
  runInBackgroundContext?: <T>(callback: () => T) => T;
}
export interface OwnerMethodDescriptor {
  name: string;
  owner: { kind: string; pluginId?: string };
  scope?: string;
  profileAccess?: string;
}
export interface OwnerNativeRequest {
  params: Record<string, unknown>;
  respond(ok: boolean, value?: unknown, error?: { code: string; message: string }): void;
  signal?: AbortSignal;
  client?: { connect: { client: { mode: string } } } | null;
  hasCurrentClientAuthority?: () => boolean;
  context: { getGatewayMethodRegistry?(): { descriptors(): readonly OwnerMethodDescriptor[] } };
}
export interface OwnerNativeApi {
  id: string;
  lifecycle: OwnerNativeLifecycle;
  runtime: { gateway: {
    request<T = unknown>(method: string, params?: Record<string, unknown>, options?: { scopes?: Array<'operator.read' | 'operator.admin'> }): Promise<T>;
  } };
  registerGatewayMethod(method: string, handler: (request: OwnerNativeRequest) => void | Promise<void>, options: { scope: 'operator.read'; profileAccess: 'independent' }): void;
}

/** Internal ABI shared by separately bundled public SDK consumers. No executor is retained. */
export interface OwnerConsumerRecord {
  readonly pluginId: string;
  readonly registrationId: string;
  isCurrent(): boolean;
  isPending(nonce: string): boolean;
  hasGrant(scope: string, token: string): boolean;
  onRetire(cleanup: () => void): () => void;
}
export interface OwnerProofBridge {
  version: 1;
  consumers: Map<string, OwnerConsumerRecord>;
  providers: Map<string, OwnerProvider>;
}
