import { createHash } from 'crypto';
import path from 'path';

import { getAgentCliCommandName } from '../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../shared/productMetadata';

export const resolvePackagedAgentCliExecutable = (productExecutable: string): string =>
  path.join(path.dirname(productExecutable), `${getAgentCliCommandName(PRODUCT_NAME)}.exe`);

export const resolveDevelopmentAgentCliExecutable = (
  appPath: string,
  userDataPath: string,
): string => {
  const profile = createHash('sha256')
    .update(path.resolve(userDataPath))
    .digest('hex')
    .slice(0, 16);
  return path.join(
    path.resolve(appPath),
    '.agent-tasks',
    'external-agent',
    'development',
    profile,
    `${getAgentCliCommandName(PRODUCT_NAME)}.exe`,
  );
};
