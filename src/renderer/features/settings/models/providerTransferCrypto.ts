const AES_GCM_IV_BYTES = 12;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// Password-based encryption/decryption for portable export/import
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT_BYTES = 16;

export interface PasswordEncryptedPayload {
  encrypted: string;
  iv: string;
  salt: string;
}

const deriveKeyFromPassword = async (password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  if (!crypto?.subtle) {
    throw new Error('Crypto API unavailable');
  }
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const encryptWithPassword = async (value: string, password: string): Promise<PasswordEncryptedPayload> => {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await deriveKeyFromPassword(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
  };
};

export const decryptWithPassword = async (payload: PasswordEncryptedPayload, password: string): Promise<string> => {
  if (!payload?.encrypted || !payload?.iv || !payload?.salt) {
    throw new Error('Invalid encrypted payload');
  }
  const salt = base64ToBytes(payload.salt);
  const key = await deriveKeyFromPassword(password, salt);
  const iv = base64ToBytes(payload.iv);
  const encrypted = base64ToBytes(payload.encrypted);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
};
