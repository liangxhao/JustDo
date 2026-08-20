import fs from 'fs';
import path from 'path';

const DEPENDENCY_CONFIG_DIR_NAME = 'dependency-config';
const NPMRC_FILE_NAME = '.npmrc';
const PIP_INI_FILE_NAME = 'pip.ini';

export const JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV = 'JUSTDO_MANAGED_PIP_CONFIG_FILE';

export interface DependencyManagerConfigPaths {
  npmUserConfigPath?: string;
  pipConfigPath?: string;
}

export const resolveDependencyManagerConfigPaths = (
  resourceDir: string,
): Required<DependencyManagerConfigPaths> => ({
  npmUserConfigPath: path.join(resourceDir, NPMRC_FILE_NAME),
  pipConfigPath: path.join(resourceDir, PIP_INI_FILE_NAME),
});

const resolveDefaultResourceDir = (): string | null => {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, DEPENDENCY_CONFIG_DIR_NAME) : null,
    path.join(process.cwd(), 'resources', DEPENDENCY_CONFIG_DIR_NAME),
    path.join(path.resolve(__dirname, '..', '..'), 'resources', DEPENDENCY_CONFIG_DIR_NAME),
    path.join(path.resolve(__dirname, '..', '..', '..'), 'resources', DEPENDENCY_CONFIG_DIR_NAME),
    path.join(
      path.resolve(__dirname, '..', '..', '..', '..'),
      'resources',
      DEPENDENCY_CONFIG_DIR_NAME,
    ),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
};

export const resolveDependencyManagerConfig = (
  resourceDir = resolveDefaultResourceDir(),
): DependencyManagerConfigPaths => {
  if (!resourceDir) {
    return {};
  }

  const targetPaths = resolveDependencyManagerConfigPaths(resourceDir);
  const result: DependencyManagerConfigPaths = {};

  if (
    fs.existsSync(targetPaths.npmUserConfigPath) &&
    fs.statSync(targetPaths.npmUserConfigPath).isFile()
  ) {
    result.npmUserConfigPath = targetPaths.npmUserConfigPath;
  }
  if (fs.existsSync(targetPaths.pipConfigPath) && fs.statSync(targetPaths.pipConfigPath).isFile()) {
    result.pipConfigPath = targetPaths.pipConfigPath;
  }

  return result;
};

export const applyDependencyManagerConfigEnv = (
  env: Record<string, string | undefined>,
  resourceDir = resolveDefaultResourceDir(),
): DependencyManagerConfigPaths => {
  // Never trust provenance inherited from the host. This function owns the exact value pair.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV) delete env[key];
  }
  const paths = resolveDependencyManagerConfig(resourceDir);
  if (paths.npmUserConfigPath) {
    env.NPM_CONFIG_USERCONFIG = paths.npmUserConfigPath;
    env.npm_config_userconfig = paths.npmUserConfigPath;
  }
  if (paths.pipConfigPath) {
    env.PIP_CONFIG_FILE = paths.pipConfigPath;
    env[JUSTDO_MANAGED_PIP_CONFIG_FILE_ENV] = paths.pipConfigPath;
  }
  return paths;
};
