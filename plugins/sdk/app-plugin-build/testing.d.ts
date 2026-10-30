import type { AppBrowserRuntime } from '@app-plugin/sdk/browser-runtime';

/** Supplies public ports before importing the plugin. Does not emulate application services. */
export function installBrowserRuntime(runtime: AppBrowserRuntime): () => void;
