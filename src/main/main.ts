import { basename } from 'node:path';

import { app, dialog } from 'electron';

import { BROWSER_AUTHENTICATION_SWITCH } from '../shared/browser/browserAuthentication';
import { PRODUCT_NAME } from '../shared/productMetadata';
import { BROWSER_AUTHENTICATION_EXECUTABLE } from './browser/authentication/browserAuthenticationConfig';
import { runBrowserAuthenticationHelper } from './browser/authentication/browserAuthenticationHelper';
import { runStorageBootstrap } from './storage/storageBootstrap';
import { formatStorageStartupFailure } from './storage/storageStartupFailure';

const authenticationAlias =
  process.platform === 'win32' &&
  `${PRODUCT_NAME.toLowerCase()}.exe` !== BROWSER_AUTHENTICATION_EXECUTABLE &&
  basename(process.execPath).toLowerCase() === BROWSER_AUTHENTICATION_EXECUTABLE &&
  (app.isPackaged || !process.defaultApp);

if (authenticationAlias || process.argv.includes(BROWSER_AUTHENTICATION_SWITCH)) {
  runBrowserAuthenticationHelper();
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
