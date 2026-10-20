import { createHash } from 'crypto';
import path from 'path';

import { PRODUCT_NAME } from '../../../shared/productMetadata';

export const resolvePackagedMulticaAgentExecutable = (productExecutable: string): string =>
  path.join(path.dirname(productExecutable), `${PRODUCT_NAME}-agent.exe`);

export const resolveMulticaDevAgentExecutable = (appPath: string, userDataPath: string): string => {
  const profile = createHash('sha256')
    .update(path.resolve(userDataPath))
    .digest('hex')
    .slice(0, 16);
  return path.join(
    path.resolve(appPath),
    '.agent-tasks',
    'multica',
    'development',
    profile,
    `${PRODUCT_NAME}-agent.exe`,
  );
};

export const resolveMulticaDevApplicationPath = (appPath: string): string => path.resolve(appPath);
