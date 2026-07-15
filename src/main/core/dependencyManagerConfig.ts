import fs from 'fs';
import path from 'path';

const DEPENDENCY_CONFIG_DIR_NAME = 'dependency-config';
const NPMRC_FILE_NAME = '.npmrc';
const PIP_INI_FILE_NAME = 'pip.ini';

export interface DependencyManagerConfigPaths {
  npmUserConfigPath?: string;
  pipConfigPath?: string;
}

export const resolveDependencyManagerConfigPaths = (
  userDataPath: string,
): Required<DependencyManagerConfigPaths> => ({
  npmUserConfigPath: path.join(userDataPath, DEPENDENCY_CONFIG_DIR_NAME, '.npmrc'),
  pipConfigPath: path.join(userDataPath, DEPENDENCY_CONFIG_DIR_NAME, 'pip.ini'),
});

const resolveDefaultResourceDir = (): string | null => {
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, DEPENDENCY_CONFIG_DIR_NAME)
      : null,
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

const copyFileIfChanged = (sourcePath: string, targetPath: string): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const content = fs.readFileSync(sourcePath);
  if (fs.existsSync(targetPath) && fs.readFileSync(targetPath).equals(content)) {
    return;
  }
  fs.writeFileSync(targetPath, content);
};

export const ensureDependencyManagerConfig = (
  userDataPath: string,
  resourceDir = resolveDefaultResourceDir(),
): DependencyManagerConfigPaths => {
  if (!resourceDir) {
    return {};
  }

  const targetPaths = resolveDependencyManagerConfigPaths(userDataPath);
  const sourceNpmrcPath = path.join(resourceDir, NPMRC_FILE_NAME);
  const sourcePipIniPath = path.join(resourceDir, PIP_INI_FILE_NAME);
  const result: DependencyManagerConfigPaths = {};

  if (fs.existsSync(sourceNpmrcPath) && fs.statSync(sourceNpmrcPath).isFile()) {
    copyFileIfChanged(sourceNpmrcPath, targetPaths.npmUserConfigPath);
    result.npmUserConfigPath = targetPaths.npmUserConfigPath;
  }
  if (fs.existsSync(sourcePipIniPath) && fs.statSync(sourcePipIniPath).isFile()) {
    copyFileIfChanged(sourcePipIniPath, targetPaths.pipConfigPath);
    result.pipConfigPath = targetPaths.pipConfigPath;
  }

  return result;
};

export const applyDependencyManagerConfigEnv = (
  env: Record<string, string | undefined>,
  userDataPath: string,
  resourceDir?: string | null,
): DependencyManagerConfigPaths => {
  const paths = ensureDependencyManagerConfig(userDataPath, resourceDir);
  if (paths.npmUserConfigPath) {
    env.NPM_CONFIG_USERCONFIG = paths.npmUserConfigPath;
    env.npm_config_userconfig = paths.npmUserConfigPath;
  }
  if (paths.pipConfigPath) {
    env.PIP_CONFIG_FILE = paths.pipConfigPath;
  }
  return paths;
};
