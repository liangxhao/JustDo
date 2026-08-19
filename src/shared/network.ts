export const NetworkIpc = {
  Fetch: 'api:fetch',
  CancelFetch: 'api:cancelFetch',
} as const;

export interface ApiFetchOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  requestId?: string;
}
