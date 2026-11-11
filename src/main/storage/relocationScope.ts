import { LOGIN_STORAGE_CONFIG } from '../../config/loginStorage';
import { AGENT_CLI_BRIDGE_DIRECTORY } from '../../shared/integrations/agentCli';
import { UPGRADE_BACKUP_DIRECTORY } from '../../shared/storage/storageDirectory';
import { BROWSER_CACHE_DIRECTORIES } from './browserCachePaths';
import { StorageRelocationFile } from './relocationState';

const fixedDirectories = [LOGIN_STORAGE_CONFIG.directoryName, 'outbound-header-proxy'];
const generatedDirectories = [AGENT_CLI_BRIDGE_DIRECTORY, 'chrome-extension'];
const cachesToRebuild = [...BROWSER_CACHE_DIRECTORIES] as const;
const controlEntries = [
  ...Object.values(StorageRelocationFile).filter(name => name !== StorageRelocationFile.Journal),
  'lockfile',
];

/** Ordinary entries are copied by default. These rules apply only at the data root. */
export const RELOCATION_ROOT_SCOPE = {
  skipCopy: [
    ...fixedDirectories,
    UPGRADE_BACKUP_DIRECTORY,
    ...generatedDirectories,
    ...cachesToRebuild,
    ...controlEntries,
  ],
  protectFromCleanup: [
    ...fixedDirectories,
    ...controlEntries,
    StorageRelocationFile.Journal,
    'SingletonCookie', 'SingletonLock', 'SingletonSocket',
  ],
  cleanSkippedCaches: cachesToRebuild,
  cleanableDirectories: [
    UPGRADE_BACKUP_DIRECTORY, // Older receipts can contain this entry. The executor preserves it.
    'logs', 'local-speech-models',
    'Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker',
    'Shared Dictionary', 'File System', 'blob_storage', 'WebStorage',
    ...cachesToRebuild,
  ],
  cleanableFiles: [
    'Cookies', 'Cookies-journal', 'Local State', 'Preferences', 'Secure Preferences',
    'QuotaManager', 'QuotaManager-journal',
  ],
} as const;
