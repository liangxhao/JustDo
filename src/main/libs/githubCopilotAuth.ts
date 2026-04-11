/**
 * GitHub Copilot OAuth Device Flow service.
 *
 * NOTE: External OAuth authentication has been disabled for local deployment.
 * This file provides stub implementations that preserve the interface structure
 * for future custom platform integration.
 *
 * Original implementation connected to GitHub OAuth service.
 */

import { session } from 'electron';

// Stub URLs - no actual external calls will be made
const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = '';
const ACCESS_TOKEN_URL = '';
const COPILOT_TOKEN_URL = '';

export const DEFAULT_COPILOT_API_BASE_URL = '';

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface CopilotAuthStatus {
  status: 'idle' | 'awaiting_user' | 'polling' | 'authenticated' | 'error';
  userCode?: string;
  verificationUri?: string;
  error?: string;
  /** The Copilot API token (Bearer token for the Copilot API endpoint) */
  token?: string;
  /** GitHub username after successful auth */
  githubUser?: string;
}

let currentPollAbort: AbortController | null = null;

/**
 * Derive the Copilot API base URL from a Copilot token.
 * Stub implementation - returns null as no external tokens are available.
 */
export function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  return null;
}

/**
 * Step 1: Request a device code from GitHub.
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  throw new Error(
    'GitHub Copilot OAuth is disabled. This app is configured for local-only deployment.',
  );
}

/**
 * Step 2: Poll GitHub for the access token.
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function pollForAccessToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  onStatusChange?: (status: string) => void,
): Promise<string> {
  cancelPolling();
  throw new Error(
    'GitHub Copilot OAuth is disabled. This app is configured for local-only deployment.',
  );
}

/**
 * Step 3: Get Copilot API token using the GitHub OAuth token.
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function getCopilotToken(githubAccessToken: string): Promise<{
  token: string;
  expiresAt: number;
  baseUrl: string;
}> {
  throw new Error(
    'GitHub Copilot OAuth is disabled. This app is configured for local-only deployment.',
  );
}

/**
 * Get GitHub user info to verify the token and display the username.
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function getGitHubUser(accessToken: string): Promise<string> {
  throw new Error(
    'GitHub Copilot OAuth is disabled. This app is configured for local-only deployment.',
  );
}

/**
 * Cancel any ongoing polling.
 */
export function cancelPolling(): void {
  if (currentPollAbort) {
    currentPollAbort.abort();
    currentPollAbort = null;
  }
}

/**
 * Full device code authentication flow.
 * Stub implementation - throws error indicating OAuth is disabled.
 */
export async function authenticateWithDeviceFlow(
  onDeviceCode: (userCode: string, verificationUri: string) => void,
  onStatusChange?: (status: string) => void,
): Promise<{
  copilotToken: string;
  githubToken: string;
  githubUser: string;
  expiresAt: number;
  baseUrl: string;
}> {
  throw new Error(
    'GitHub Copilot OAuth is disabled. This app is configured for local-only deployment.',
  );
}
