import { createHash } from 'crypto';
import path from 'path';

import { getAgentCliCommandName } from '../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../shared/productMetadata';

export const resolvePackagedAgentCliExecutable = (productExecutable: string): string =>
  path.join(path.dirname(productExecutable), `${getAgentCliCommandName(PRODUCT_NAME)}.exe`);

export const resolveDevelopmentAgentCliExecutable = (
  appPath: string,
  profileOverride?: string,
): string => {
  const profileSlot = profileOverride
    ? [createHash('sha256').update(path.resolve(profileOverride)).digest('hex').slice(0, 16)]
    : [];
  return path.join(
    path.resolve(appPath),
    '.agent-tasks',
    'external-agent',
    'development',
    ...profileSlot,
    `${getAgentCliCommandName(PRODUCT_NAME)}.exe`,
  );
};
