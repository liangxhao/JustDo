import { describe, expect, test } from 'vitest';

import { getCommandDangerLevel, isDangerousCommand, isDeleteCommand } from './commandSafety';

describe('isDeleteCommand', () => {
  test.each([
    'rm file.txt',
    'rm -i obsolete.log',
    'rmdir /tmp/build',
    'unlink /var/run/app.pid',
    'del C:\\Users\\foo\\bar.txt',
    'erase temp.dat',
    'Remove-Item -Path C:\\Logs\\*.log',
    'find . -name "*.tmp" -delete',
    'git clean -fd',
    'git clean -fdx',
  ])('matches %s', command => {
    expect(isDeleteCommand(command)).toBe(true);
  });

  test.each(['ls -la /tmp', 'git push origin main', 'echo "hello world"', 'npm install react'])(
    'does not match %s',
    command => {
      expect(isDeleteCommand(command)).toBe(false);
    },
  );
});

describe('isDangerousCommand', () => {
  test.each([
    'rm -rf /tmp/old',
    'git push origin main',
    'git push -u origin feat/my-branch',
    'git reset --hard HEAD~1',
    'kill -9 12345',
    'killall node',
    'pkill -f my-server',
    'chmod 777 /usr/local/bin/app',
    'chown root:root /etc/shadow',
  ])('matches %s', command => {
    expect(isDangerousCommand(command)).toBe(true);
  });

  test.each(['ls -la', 'cat README.md', 'npm install', 'git status', 'git log --oneline -10'])(
    'does not match %s',
    command => {
      expect(isDangerousCommand(command)).toBe(false);
    },
  );
});

describe('getCommandDangerLevel', () => {
  test.each([
    ['rm -rf /tmp/old', 'destructive', 'recursive-delete'],
    ['rm -r build/', 'destructive', 'recursive-delete'],
    ['rm --recursive dist/', 'destructive', 'recursive-delete'],
    ['git push --force origin main', 'destructive', 'git-force-push'],
    ['git push -f origin feat/fix', 'destructive', 'git-force-push'],
    ['git reset --hard HEAD~3', 'destructive', 'git-reset-hard'],
    ['dd if=/dev/zero of=/dev/sda bs=512', 'destructive', 'disk-overwrite'],
    ['mkfs.ext4 /dev/sdb1', 'destructive', 'disk-format'],
    ['rm old-file.txt', 'caution', 'file-delete'],
    ['find /tmp -name "*.log" -mtime +7 -delete', 'caution', 'file-delete'],
    ['git clean -fd', 'caution', 'file-delete'],
    ['git push origin main', 'caution', 'git-push'],
    ['kill -9 9876', 'caution', 'process-kill'],
    ['chmod 755 deploy.sh', 'caution', 'permission-change'],
    ['chown www-data:www-data /var/www/app', 'caution', 'permission-change'],
    ['ls -la /tmp', 'safe', ''],
    ['git status', 'safe', ''],
    ['npm install lodash', 'safe', ''],
    ['echo "deployment complete"', 'safe', ''],
    ['', 'safe', ''],
  ])('classifies %s', (command, level, reason) => {
    expect(getCommandDangerLevel(command)).toEqual({ level, reason });
  });
});
