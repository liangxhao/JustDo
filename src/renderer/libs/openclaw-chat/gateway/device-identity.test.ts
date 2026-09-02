import { describe, expect, it } from 'vitest';

import {
  buildGatewayDeviceAuthPayload,
  loadOrCreateGatewayDeviceIdentity,
} from './device-identity';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(Buffer.from(normalized, 'base64'));
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe('Gateway device identity', () => {
  it('persists one Ed25519 identity and signs payloads accepted by WebCrypto', async () => {
    const storage = new MemoryStorage();
    const first = await loadOrCreateGatewayDeviceIdentity(storage);
    const second = await loadOrCreateGatewayDeviceIdentity(storage);
    const payload = 'v3|device|client|webchat|operator|operator.read|1|token|nonce|win32|';
    const signature = await second.sign(payload);
    const publicKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(decodeBase64Url(second.publicKey)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

    expect(second.deviceId).toBe(first.deviceId);
    await expect(
      crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        toArrayBuffer(decodeBase64Url(signature)),
        new TextEncoder().encode(payload),
      ),
    ).resolves.toBe(true);
  });

  it('builds the v2026.8.1 v3 signature payload byte-for-byte', () => {
    expect(
      buildGatewayDeviceAuthPayload({
        deviceId: 'device',
        clientId: 'openclaw-control-ui',
        clientMode: 'webchat',
        role: 'operator',
        scopes: ['operator.admin', 'operator.read'],
        signedAtMs: 123,
        token: 'token',
        nonce: 'nonce',
        platform: 'Win32',
      }),
    ).toBe(
      'v3|device|openclaw-control-ui|webchat|operator|operator.admin,operator.read|123|token|nonce|win32|',
    );
  });
});
