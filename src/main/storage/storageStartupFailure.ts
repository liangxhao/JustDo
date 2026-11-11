const locations = {
  configuration: ['无法准备配置目录。', 'Could not prepare the configuration folder.'],
  locator: ['数据位置记录无法读取或校验失败。', 'Could not read or validate the saved data location.'],
  missingLocator: ['找不到数据位置记录。请保留数据目录并联系维护人员恢复记录。', 'The saved data location is missing. Keep the data folder and contact support to recover the record.'],
  data: ['无法打开已保存的数据目录。', 'Could not open the saved data folder.'],
  folderAlias: ['此路径经过目录联接或别名。请使用实际文件夹的路径。', 'This path uses a directory junction or alias. Use the path to the actual folder.'],
  notFolder: ['此位置不是文件夹。请核对目录路径。', 'This location is not a folder. Check the folder path.'],
  identity: ['目录标识缺失或与数据位置记录不匹配。请确认路径指向原来的数据目录。', 'The folder identity is missing or does not match the saved location. Check that this path points to the original data folder.'],
  journal: ['数据迁移记录无法读取或校验失败。', 'Could not read or validate the migration record.'],
  recovery: ['无法准备数据恢复目录。', 'Could not prepare the data recovery folder.'],
  recoveryWindow: ['无法打开数据恢复窗口。', 'Could not open the data recovery window.'],
  startup: ['应用初始化失败。请查看启动日志。', 'Application initialization failed. Check the startup log.'],
} as const;

const systemReasons: Record<string, readonly [string, string]> = {
  ENOENT: ['系统找不到此路径。请确认原磁盘已连接，且路径仍然存在。', 'The system cannot find this path. Check that the original drive is connected and the path still exists.'],
  ENOTDIR: ['路径中的某一项不是文件夹。请核对所用的目录。', 'A component of the path is not a folder. Check the folder location.'],
  EACCES: ['系统拒绝访问。请检查当前账户对该位置的权限。', 'Access was denied. Check the current account’s permissions for this location.'],
  EPERM: ['系统拒绝执行此操作。请检查当前账户的权限。', 'The system denied this operation. Check the current account’s permissions.'],
  EBUSY: ['该位置正在被占用。请关闭使用它的程序后重试。', 'This location is in use. Close the application using it and retry.'],
  ENOSPC: ['磁盘空间不足。请释放空间后重试。', 'The drive is full. Free some space and retry.'],
  EROFS: ['磁盘为只读状态。请恢复写入权限后重试。', 'The drive is read-only. Restore write access and retry.'],
  EIO: ['磁盘读写失败。请检查磁盘连接及状态。', 'A disk read or write failed. Check the drive connection and condition.'],
};

export class StorageStartupFailure extends Error {
  constructor(
    readonly location: keyof typeof locations,
    readonly path?: string,
    cause?: unknown,
  ) {
    super(locations[location][1], { cause });
  }
}

export function atStorageLocation<T>(
  location: StorageStartupFailure['location'],
  path: string,
  run: () => T,
): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof StorageStartupFailure && location !== 'data') throw error;
    throw new StorageStartupFailure(location, path, error);
  }
}

export function describeStorageSystemReason(code: string | undefined, language: 'zh' | 'en'): string | undefined {
  if (!code || !Object.hasOwn(systemReasons, code)) return undefined;
  return systemReasons[code][language === 'zh' ? 0 : 1] + ' (' + code + ')';
}

export function describeStorageStartupFailure(error: unknown, language: 'zh' | 'en') {
  const index = language === 'zh' ? 0 : 1;
  let location: StorageStartupFailure['location'] = 'startup';
  let path: string | undefined;
  let dataPath: string | undefined;
  let reason: string | undefined;
  for (let current = error, depth = 0; current instanceof Error && depth < 6; depth++, current = current.cause) {
    if (current instanceof StorageStartupFailure) {
      location = current.location;
      path = current.path ?? path;
      if (location === 'data' || location === 'identity') dataPath = current.path;
    }
    reason = describeStorageSystemReason((current as NodeJS.ErrnoException).code, language);
    if (reason) break;
    if (current instanceof SyntaxError && (location === 'locator' || location === 'journal' || location === 'data')) {
      reason = language === 'zh' ? '记录格式无效。请保留此文件并联系维护人员。' : 'The record format is invalid. Keep the file and contact support.';
      break;
    }
  }
  return {
    detail: [locations[location][index], reason].filter(Boolean).join('\n'),
    path,
    dataPath,
  };
}

export function formatStorageStartupFailure(error: unknown, language: 'zh' | 'en'): string {
  const { detail, path, dataPath } = describeStorageStartupFailure(error, language);
  const chinese = language === 'zh';
  const data = chinese ? `数据路径\n${dataPath ?? '暂无法确认'}` : `Data folder\n${dataPath ?? 'Could not determine'}`;
  const failed = path && path !== dataPath
    ? `${chinese ? '出错位置' : 'Failed location'}\n${path}`
    : undefined;
  return [detail, data, failed].filter(Boolean).join('\n\n');
}
