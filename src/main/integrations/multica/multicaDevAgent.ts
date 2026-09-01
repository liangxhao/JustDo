import fs from 'fs';
import path from 'path';

import { PRODUCT_NAME } from '../../../shared/productMetadata';

const requireAgentExecutable = (executablePath: string, errorMessage: string): string => {
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error(errorMessage);
  }
  return executablePath;
};

export const resolvePackagedMulticaAgentExecutable = (productExecutablePath: string): string =>
  requireAgentExecutable(
    path.join(path.dirname(productExecutablePath), `${PRODUCT_NAME}-agent.exe`),
    'The packaged Multica Agent executable is missing.',
  );

export const resolveMulticaDevAgentExecutable = (
  appPath: string,
  userDataPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform !== 'win32') {
    throw new Error('The native Multica development Agent executable is only required on Windows.');
  }
  const executablePath = path.resolve(
    userDataPath,
    'multica',
    'development',
    `${PRODUCT_NAME}-agent.exe`,
  );
  return requireAgentExecutable(
    executablePath,
    `The Multica development Agent executable is missing. Run npm run multica:dev-agent in ${appPath}.`,
  );
};
