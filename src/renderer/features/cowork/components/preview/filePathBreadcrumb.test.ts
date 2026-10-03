import { describe, expect, it } from 'vitest';

import { fitFilePathBreadcrumb, getFilePathBreadcrumb } from './filePathBreadcrumb';

describe('file path breadcrumbs', () => {
  it('starts project files with the project name, including files directly in its root', () => {
    expect(getFilePathBreadcrumb('E:\\Work\\Project\\src\\main.ts', 'e:/work/project/')).toEqual([
      'project',
      'src',
      'main.ts',
    ]);
    expect(getFilePathBreadcrumb('/work/项目/说明.md', '/work/项目')).toEqual(['项目', '说明.md']);
  });

  it('keeps absolute paths for other projects and preserves POSIX case sensitivity', () => {
    expect(getFilePathBreadcrumb('E:/work/project-other/main.ts', 'E:/work/project')).toEqual([
      'E:',
      'work',
      'project-other',
      'main.ts',
    ]);
    expect(getFilePathBreadcrumb('/work/Project/main.ts', '/work/project')).toEqual([
      '/',
      'work',
      'Project',
      'main.ts',
    ]);
    expect(
      getFilePathBreadcrumb('//server/share/project/main.ts', '//SERVER/share/Project'),
    ).toEqual(['Project', 'main.ts']);
  });

  it('restores full directories when space is available and keeps the most trailing directories that fit', () => {
    const widths = [50, 70, 90, 40, 100];
    expect(fitFilePathBreadcrumb(widths, 500)).toEqual({ tailStart: 1, truncate: false });
    expect(fitFilePathBreadcrumb(widths, 385)).toEqual({ tailStart: 2, truncate: false });
    expect(fitFilePathBreadcrumb(widths, 280)).toEqual({ tailStart: 3, truncate: false });
    expect(fitFilePathBreadcrumb(widths, 230)).toEqual({ tailStart: 4, truncate: false });
    expect(fitFilePathBreadcrumb(widths, 150)).toEqual({ tailStart: 4, truncate: true });
  });

  it('truncates a root-level or standalone filename without inventing hidden directories', () => {
    expect(fitFilePathBreadcrumb([100, 300], 120)).toEqual({ tailStart: 1, truncate: true });
    expect(fitFilePathBreadcrumb([300], 120)).toEqual({ tailStart: 1, truncate: true });
    expect(fitFilePathBreadcrumb([], 0)).toEqual({ tailStart: 1, truncate: false });
  });
});
