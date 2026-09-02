const DEVICE_IDENTITY_STORAGE_KEY = 'justdo.openclaw.gateway-device-identity.v1';

type StoredGatewayDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: JsonWebKey;
  createdAtMs: number;
};

export type GatewayDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  sign(payload: string): Promise<string>;
};

type DeviceIdentityStorage = Pick<Storage, 'getItem' | 'setItem'>;

let sessionIdentityPromise: Promise<GatewayDeviceIdentity> | null = null;

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const resolveCrypto = (): Crypto => {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error('WebCrypto is unavailable for the Gateway device identity');
  return crypto;
};

const fingerprintPublicKey = async (publicKey: Uint8Array): Promise<string> => {
  const digest = await resolveCrypto().subtle.digest('SHA-256', toArrayBuffer(publicKey));
  return bytesToHex(new Uint8Array(digest));
};

const createIdentity = (stored: StoredGatewayDeviceIdentity): GatewayDeviceIdentity => ({
  deviceId: stored.deviceId,
  publicKey: stored.publicKey,
  async sign(payload: string): Promise<string> {
    const crypto = resolveCrypto();
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      stored.privateKey,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      privateKey,
      new TextEncoder().encode(payload),
    );
    return encodeBase64Url(new Uint8Array(signature));
  },
});

const parseStoredIdentity = async (raw: string): Promise<StoredGatewayDeviceIdentity | null> => {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGatewayDeviceIdentity>;
    if (
      parsed.version !== 1 ||
      typeof parsed.deviceId !== 'string' ||
      typeof parsed.publicKey !== 'string' ||
      typeof parsed.createdAtMs !== 'number' ||
      !parsed.privateKey ||
      parsed.privateKey.kty !== 'OKP' ||
      parsed.privateKey.crv !== 'Ed25519' ||
      typeof parsed.privateKey.d !== 'string' ||
      parsed.privateKey.x !== parsed.publicKey
    ) {
      return null;
    }
    const expectedDeviceId = await fingerprintPublicKey(decodeBase64Url(parsed.publicKey));
    if (expectedDeviceId !== parsed.deviceId) return null;
    await resolveCrypto().subtle.importKey('jwk', parsed.privateKey, { name: 'Ed25519' }, false, [
      'sign',
    ]);
    return parsed as StoredGatewayDeviceIdentity;
  } catch {
    return null;
  }
};

const generateIdentity = async (): Promise<StoredGatewayDeviceIdentity> => {
  const crypto = resolveCrypto();
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const [privateKey, publicKeyBytes] = await Promise.all([
    crypto.subtle.exportKey('jwk', keys.privateKey),
    crypto.subtle.exportKey('raw', keys.publicKey),
  ]);
  const publicKey = encodeBase64Url(new Uint8Array(publicKeyBytes));
  if (
    privateKey.kty !== 'OKP' ||
    privateKey.crv !== 'Ed25519' ||
    typeof privateKey.d !== 'string' ||
    privateKey.x !== publicKey
  ) {
    throw new Error('WebCrypto returned an invalid Ed25519 Gateway identity');
  }
  return {
    version: 1,
    deviceId: await fingerprintPublicKey(new Uint8Array(publicKeyBytes)),
    publicKey,
    privateKey,
    createdAtMs: Date.now(),
  };
};

const resolveStorage = (): DeviceIdentityStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const loadOrCreateGatewayDeviceIdentity = async (
  storage: DeviceIdentityStorage | null = resolveStorage(),
): Promise<GatewayDeviceIdentity> => {
  try {
    const raw = storage?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (raw) {
      const stored = await parseStoredIdentity(raw);
      if (stored) return createIdentity(stored);
    }
  } catch {
    // A blocked or malformed store falls back to one stable in-memory identity.
  }

  sessionIdentityPromise ??= generateIdentity().then(stored => {
    try {
      storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // The identity remains stable for this renderer lifetime when storage is blocked.
    }
    return createIdentity(stored);
  });
  return sessionIdentityPromise;
};

export const buildGatewayDeviceAuthPayload = (params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string => {
  const normalizeMetadata = (value?: string | null) => value?.trim().toLowerCase() ?? '';
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAtMs),
    params.token ?? '',
    params.nonce,
    normalizeMetadata(params.platform),
    normalizeMetadata(params.deviceFamily),
  ].join('|');
};
