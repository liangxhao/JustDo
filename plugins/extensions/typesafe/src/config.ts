import manifest from "../openclaw.plugin.json" with { type: "json" };

export const ConfigSchema = manifest.configSchema;
const localBaseUrlPattern = new RegExp(ConfigSchema.properties.baseUrl.pattern);

export type RuntimeConfig = { apiKey?: string; baseUrl?: string; serviceUrl?: string; timeoutMs: number };

/** A configured endpoint grants access to one loopback origin, never arbitrary private hosts. */
export function localBaseUrl(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed =
    typeof value === "string" && value === value.trim() && localBaseUrlPattern.test(value)
      ? URL.parse(value)
      : null;
  if (!parsed) {
    throw new Error(
      "Invalid TypeSafe baseUrl; use an http(s) loopback origin without a path, credentials, query, or fragment.",
    );
  }
  return parsed.origin;
}

/** Explicit authenticated System One API base, including its version/path prefix. */
export function serviceBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Invalid TypeSafe serviceUrl; use an http(s) API base without credentials, query, or fragment.");
  }
}

/** Validate runtime settings and recognize materialized credentials without resolving inputs. */
export function runtimeConfig(config: Record<string, unknown> | undefined): RuntimeConfig {
  const serviceUrl = serviceBaseUrl(config?.serviceUrl);
  if (serviceUrl && config?.baseUrl !== undefined) throw new Error("Configure only one TypeSafe endpoint.");
  const baseUrl = localBaseUrl(config?.baseUrl);
  const timeoutMs = config?.timeoutMs ?? 30000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  ) {
    throw new Error("Invalid TypeSafe configuration; check plugin Settings.");
  }
  if (baseUrl) {
    return { baseUrl, timeoutMs };
  }
  const key = config?.apiKey;
  return { serviceUrl, apiKey: typeof key === "string" && key.trim() ? key : undefined, timeoutMs };
}
