export const matchAutoLinkPathPrefix = (value: string): string | null => {
  const match =
    value.match(/^file:\/\/[^\s<>"'`|[\]{}]+/i) ??
    value.match(/^[A-Za-z]:[\\/][^\s<>"'`|[\]{}]+/) ??
    // A POSIX path starts with exactly one slash. Two slashes may be the
    // authority marker in an URL (for example https://example.com/path).
    value.match(/^\/(?!\/)(?:[^\s<>"'`|[\]{}]+\/)+[^\s<>"'`|[\]{}]+/);

  return match?.[0] ?? null;
};
