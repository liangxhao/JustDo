# Skill Marketplace Adapter

## Purpose

JustDo exposes a stable marketplace model to the renderer while allowing the actual marketplace
to use OpenClaw Gateway RPC, private HTTP APIs, or another transport. Marketplace-specific DTOs,
authentication, URLs, and error handling belong in one provider under:

`src/main/libs/skillMarketplace/`

The renderer must not call a marketplace server directly. This keeps credentials in the main
process and preserves Electron process isolation.

## Architecture

```text
Renderer SkillService
        |
        | skills:search / skills:detail / skills:install
        v
Main-process IPC
        |
        v
SkillMarketplaceService       stable validation and normalized models
        |
        v
SkillMarketplaceProvider      replaceable contract
        |
        +-- OpenClawGatewayMarketplaceProvider (current default)
        |
        +-- PrivateClawHubProvider (your implementation)
```

`SkillMarketplaceService` normalizes queries, limits, slugs, and versions. A provider implements
only three operations:

```typescript
interface SkillMarketplaceProvider {
  readonly kind: string;
  search(options: MarketplaceSearchOptions): Promise<MarketplaceSkillSummary[]>;
  getDetail(slug: string): Promise<MarketplaceSkillDetail | null>;
  install(options: MarketplaceInstallOptions): Promise<MarketplaceInstallResult>;
}
```

## Migrating to a private ClawHub

1. Add `privateClawHubProvider.ts` beside the existing provider.
2. Implement `SkillMarketplaceProvider`.
3. Map the private server's request and response fields to the normalized types in `types.ts`.
4. Change only `providerFactory.ts` to construct the private provider.
5. Add provider contract tests and run the verification commands below.

Minimal HTTP example:

```typescript
import type {
  MarketplaceInstallOptions,
  MarketplaceInstallResult,
  MarketplaceSearchOptions,
  MarketplaceSkillDetail,
  MarketplaceSkillSummary,
  SkillMarketplaceProvider,
} from './types';

export class PrivateClawHubProvider implements SkillMarketplaceProvider {
  readonly kind = 'private-clawhub';

  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  async search(options: MarketplaceSearchOptions): Promise<MarketplaceSkillSummary[]> {
    const response = await this.request<{
      items: Array<{
        id: string;
        displayName: string;
        summary: string;
        latestVersion: string;
      }>;
    }>(`/api/skills?q=${encodeURIComponent(options.query || '')}&limit=${options.limit}`);

    return response.items.map(item => ({
      slug: item.id,
      name: item.displayName,
      description: item.summary,
      version: item.latestVersion,
    }));
  }

  async getDetail(slug: string): Promise<MarketplaceSkillDetail | null> {
    // Fetch the private DTO and map it to MarketplaceSkillDetail.
    throw new Error(`Implement private detail mapping for ${slug}`);
  }

  async install(options: MarketplaceInstallOptions): Promise<MarketplaceInstallResult> {
    // Download/import an archive, or ask the private server/Gateway to install it.
    throw new Error(`Implement private install flow for ${options.slug}`);
  }

  private async request<T>(pathname: string): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl), {
      headers: { Authorization: `Bearer ${await this.getToken()}` },
    });
    if (!response.ok) {
      throw new Error(`Private marketplace request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }
}
```

Then change the body of `createSkillMarketplaceService` in `providerFactory.ts`:

```typescript
return new SkillMarketplaceService(
  new PrivateClawHubProvider(process.env.JUSTDO_SKILL_MARKET_URL!, readEncryptedToken),
);
```

Do not hardcode the URL or token. Read the URL from deployment configuration and keep credentials
in the encrypted config store. For an internal CA, configure trust at deployment level; do not
disable TLS verification.

## Installation choices

Private markets commonly install in one of two ways:

- **Gateway-managed**: the provider sends an ID/version to a private Gateway endpoint. Return the
  endpoint result as `MarketplaceInstallResult`.
- **Archive-managed**: the provider downloads a ZIP/TGZ, verifies its digest/signature, then imports
  it through the local skill file layer. Keep archive extraction and path validation out of the
  renderer.

For archive-managed installation, require a server-provided SHA-256 digest or signature, impose a
download size limit and timeout, and reject redirects to unapproved hosts. The current
`OpenClawSkillFiles` class can perform the final validated archive import.

## Compatibility rules

- `slug`, `name`, `description`, and `version` are required normalized fields.
- Unknown private fields should be discarded or represented by a deliberate extension to the
  normalized contract.
- Provider errors may contain diagnostics for logs but must not expose tokens or response headers.
- An empty detail response maps to `null`.
- Search limits are normalized to `1..100` by the service.
- Keep provider code in the main process; shared and renderer code must not import it.

## Verification

```bash
npx vitest src/main/libs/skillMarketplace/skillMarketplaceService.test.ts
npm run lint
npm run build
npm test
```
