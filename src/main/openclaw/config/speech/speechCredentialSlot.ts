import { createHash } from 'node:crypto';

/** A failed endpoint change cannot rebind an already published reference to another service's key. */
export const buildSpeechCredentialSlot = (scope: string, baseUrl: string, apiKey: string): string =>
  `${scope}.${createHash('sha256').update(JSON.stringify([baseUrl, apiKey])).digest('hex')}.apiKey`;
