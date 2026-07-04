# Skill Marketplace Adapter

JustDo exposes skill marketplace actions through the main process only.

## Boundary

- Renderer calls `skills:search`, `skills:detail`, and `skills:install`.
- Main process normalizes inputs and talks to the configured marketplace provider.
- Marketplace credentials stay out of the renderer.

## Rules

- Keep marketplace transport in `src/main/libs/skillMarketplace/`.
- Do not let renderer code talk directly to the marketplace server.
- Normalize slugs, versions, and limits before provider calls.
- Keep credentials in the encrypted config store or another secret-managed source.

## Verification

- `npm run lint`
- `npm run build`
- `npm test`
