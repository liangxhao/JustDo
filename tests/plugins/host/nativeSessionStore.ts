/** Resolve the public SDK subpath in browser tests; real access must be explicitly mocked. */
export function getSessionEntry(): never {
  throw new Error('Native session entry reads require an explicit test fixture.');
}
