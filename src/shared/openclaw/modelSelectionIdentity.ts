import { OpenClawProviderId } from '../providers/constants';

/** Match a Gateway selection against a requested catalog route. */
export function matchesModelSelectionIdentity(requested: string, selected: string): boolean {
  if (requested === selected) return true;
  const prefix = `${OpenClawProviderId.BuiltinModels}/`;
  if (!requested.startsWith(prefix)) return false;
  const alias = requested.slice(prefix.length);
  return alias.includes('/') && alias === selected;
}
