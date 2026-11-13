import { basename } from 'node:path';

import { app, dialog } from 'electron';

import { PRODUCT_NAME } from '../shared/productMetadata';
import { BROWSER_AUTHENTICATION_EXECUTABLE } from './browser/authentication/browserAuthenticationConfig';
import { runStorageBootstrap } from './storage/storageBootstrap';
import { formatStorageStartupFailure } from './storage/storageStartupFailure';

const authenticationAlias =
  process.platform === 'win32' &&
  !process.defaultApp &&
  `${PRODUCT_NAME.toLowerCase()}.exe` !== BROWSER_AUTHENTICATION_EXECUTABLE &&
  basename(process.execPath).toLowerCase() === BROWSER_AUTHENTICATION_EXECUTABLE;

if (authenticationAlias) {
  app.exit(0);
} else {
  // Keep the production profile unopened until locator and maintenance routing are resolved.
  void runStorageBootstrap().catch(error => {
    if (app.isPackaged) {
      dialog.showErrorBox(
        PRODUCT_NAME,
        formatStorageStartupFailure(error, app.getSystemLocale().startsWith('zh') ? 'zh' : 'en'),
      );
    }
    app.exit(1);
  });
}
