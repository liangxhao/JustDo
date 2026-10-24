import { isAbsolute } from 'path';

import { t } from '../../../core/i18n';

/** buildCliEnvironment admits the bundled runtime before publishing this compatibility field. */
export const requireOpenClawCliExecutable = (env: NodeJS.ProcessEnv): string => {
  const executable = env.JUSTDO_ELECTRON_PATH?.trim();
  if (!executable || !isAbsolute(executable) || /[\r\n]/u.test(executable)) {
    throw new Error(t('runtimeNodeUnavailable'));
  }
  return executable;
};
