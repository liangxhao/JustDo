import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { DB_FILENAME } from '../core/appConstants';
import { projectRelocatedProfilePaths, readRelocatedProfilePaths } from './relocationProfilePaths';

test('moves structured paths under the old OpenClaw directory in the target databases only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relocation-profile-paths-'));
  try {
    const source = path.join(directory, 'source');
    const target = path.join(directory, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    const workspace = path.join(source, 'openclaw', 'state', 'work');
    const movedWorkspace = path.join(target, 'openclaw', 'state', 'work');
    const sibling = path.join(source, 'openclaw-external', 'project');
    const download = path.join(workspace, 'report.pdf');
    const defaultWorkspace = path.join(workspace, 'default');
    const movedDefaultWorkspace = path.join(movedWorkspace, 'default');
    expect(readRelocatedProfilePaths(target)).toEqual({ directories: [], files: [] });

    const product = new Database(path.join(source, DB_FILENAME));
    product.exec(`
      CREATE TABLE cowork_sessions (cwd TEXT);
      CREATE TABLE cowork_external_sessions (cwd TEXT);
      CREATE TABLE cowork_plan_handoffs (artifact_workspace_root TEXT);
      CREATE TABLE cowork_config (key TEXT, value TEXT);
    `);
    const session = product.prepare('INSERT INTO cowork_sessions VALUES (?)');
    session.run(workspace);
    session.run(sibling);
    product.prepare('INSERT INTO cowork_external_sessions VALUES (?)').run(workspace);
    product.prepare('INSERT INTO cowork_plan_handoffs VALUES (?)').run(workspace);
    const config = product.prepare('INSERT INTO cowork_config VALUES (?, ?)');
    config.run('workingDirectory', defaultWorkspace);
    config.run('unrelated', workspace);
    product.close();

    const browser = new Database(path.join(source, 'browser-import.sqlite'));
    browser.exec('CREATE TABLE browser_downloads (save_path TEXT)');
    const addDownload = browser.prepare('INSERT INTO browser_downloads VALUES (?)');
    for (const name of [download, download, '', null]) addDownload.run(name);
    browser.close();
    for (const file of [DB_FILENAME, 'browser-import.sqlite'])
      fs.copyFileSync(path.join(source, file), path.join(target, file));
    const original = fs.readFileSync(path.join(source, DB_FILENAME));

    projectRelocatedProfilePaths(source, target);

    expect(fs.readFileSync(path.join(source, DB_FILENAME))).toEqual(original);
    const references = readRelocatedProfilePaths(target);
    expect([...references.directories].sort()).toEqual([movedWorkspace, movedDefaultWorkspace, sibling].sort());
    expect(references.files).toEqual([path.join(movedWorkspace, 'report.pdf')]);
    const moved = new Database(path.join(target, DB_FILENAME), { readonly: true });
    try {
      expect(moved.prepare('SELECT cwd FROM cowork_sessions ORDER BY rowid').all()).toEqual([
        { cwd: movedWorkspace }, { cwd: sibling },
      ]);
      expect(moved.prepare('SELECT cwd FROM cowork_external_sessions').get()).toEqual({ cwd: movedWorkspace });
      expect(moved.prepare('SELECT artifact_workspace_root FROM cowork_plan_handoffs').get())
        .toEqual({ artifact_workspace_root: movedWorkspace });
      expect(moved.prepare('SELECT value FROM cowork_config ORDER BY rowid').all()).toEqual([
        { value: movedDefaultWorkspace }, { value: workspace },
      ]);
    } finally {
      moved.close();
    }
    const movedBrowser = new Database(path.join(target, 'browser-import.sqlite'), { readonly: true });
    try {
      expect(movedBrowser.prepare('SELECT save_path FROM browser_downloads').get())
        .toEqual({ save_path: path.join(movedWorkspace, 'report.pdf') });
    } finally {
      movedBrowser.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
