import { expect, test } from 'vitest';

import { atStorageLocation, describeStorageStartupFailure, formatStorageStartupFailure, StorageStartupFailure } from './storageStartupFailure';

test('reports the failed location and filesystem reason without exposing the underlying error text', () => {
  const path = 'D:\\assistant-data';
  const failure = new StorageStartupFailure('data', path, new Error('Control read failed.', {
    cause: Object.assign(new Error('Private error text.'), { code: 'EACCES' }),
  }));

  expect(formatStorageStartupFailure(failure, 'zh')).toBe(
    '无法打开已保存的数据目录。\n系统拒绝访问。请检查当前账户对该位置的权限。 (EACCES)\n\n数据路径\nD:\\assistant-data',
  );
  expect(formatStorageStartupFailure(failure, 'en')).toContain('Access was denied.');
});

test('describes an invalid location record without displaying its contents', () => {
  const failure = new StorageStartupFailure('locator', 'C:\\AppData\\storage-location.json',
    new SyntaxError('Invalid private data.'));

  const message = formatStorageStartupFailure(failure, 'zh');

  expect(message).toContain('记录格式无效');
  expect(message).toContain('storage-location.json');
  expect(message).toContain('数据路径\n暂无法确认');
  expect(message).toContain('出错位置\nC:\\AppData\\storage-location.json');
  expect(message).not.toContain('Invalid private data');
});

test('retains the complete data folder when an ancestor is the failed location', () => {
  const directory = 'D:\\archive\\assistant-data';
  try {
    atStorageLocation('data', directory, () => {
      throw new StorageStartupFailure('folderAlias', 'D:\\archive');
    });
  } catch (error) {
    expect(describeStorageStartupFailure(error, 'zh')).toMatchObject({
      dataPath: directory,
      path: 'D:\\archive',
    });
    return;
  }
  throw new Error('Expected the linked ancestor to fail validation.');
});
