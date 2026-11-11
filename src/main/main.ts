import { app, dialog } from 'electron';

import { PRODUCT_NAME } from '../shared/productMetadata';
import { runStorageBootstrap } from './storage/storageBootstrap';
import { formatStorageStartupFailure } from './storage/storageStartupFailure';

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
