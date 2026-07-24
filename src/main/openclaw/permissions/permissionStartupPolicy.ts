import type { CoworkStore } from '../../data/coworkStore';

export const downgradePersistedFullPermissionMode = (store: CoworkStore): boolean => {
  if (store.getConfig().permissionMode !== 'full') return false;
  store.setConfig({ permissionMode: 'ask' });
  return true;
};
