/**
 * Qwen OAuth Device Flow service.
 *
 * NOTE: External OAuth authentication has been disabled for local deployment.
 * This file provides stub implementations that preserve the interface structure
 * for future custom platform integration.
 *
 * Original implementation connected to Qwen OAuth service.
 */

import { createHash,randomBytes, randomUUID } from 'node:crypto';

// Stub URLs - no actual external calls will be made
const QWEN_OAUTH_BASE_URL = '';
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = '';
const QWEN_OAUTH_TOKEN_ENDPOINT = '';
const QWEN_OAUTH_CLIENT_ID = '';
const QWEN_OAUTH_SCOPE = '';
const QWEN_OAUTH_GRANT_TYPE = '';

export interface QwenDeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface QwenOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
}

type TokenPending = { status: 'pending'; slowDown?: boolean };
type DeviceTokenResult =
  | { status: 'success'; token: QwenOAuthToken }
  | TokenPending
  | { status: 'error'; message: string };

interface ProgressCallback {
  update: (message: string) => void;
  stop: (message?: string) => void;
}

/**
 * Stub implementation - throws error indicating OAuth is disabled.
 */
async function requestDeviceCode(params: { challenge: string }): Promise<QwenDeviceAuthorization> {
  throw new Error('Qwen OAuth is disabled. This app is configured for local-only deployment.');
}

/**
 * Stub implementation - throws error indicating OAuth is disabled.
 */
async function pollDeviceToken(params: {
  deviceCode: string;
  verifier: string;
}): Promise<DeviceTokenResult> {
  return {
    status: 'error',
    message: 'Qwen OAuth is disabled. This app is configured for local-only deployment.',
  };
}

/**
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function startQwenOAuth(progressCallback: ProgressCallback): Promise<QwenOAuthToken> {
  throw new Error('Qwen OAuth is disabled. This app is configured for local-only deployment.');
}

/**
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function refreshQwenOAuthToken(refreshToken: string): Promise<QwenOAuthToken> {
  throw new Error('Qwen OAuth is disabled. This app is configured for local-only deployment.');
}

/**
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function ensureFreshQwenOAuthToken(
  oauthCredentials: QwenOAuthToken,
): Promise<QwenOAuthToken> {
  throw new Error('Qwen OAuth is disabled. This app is configured for local-only deployment.');
}
