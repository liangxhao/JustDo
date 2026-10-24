import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const runtimeRoot = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const runtimeAvailable = fs.existsSync(path.join(runtimeRoot, 'openclaw.mjs'));

test.skipIf(!runtimeAvailable)(
  'native skills.update independently switches extension skills and preserves their other settings',
  () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-native-switch-'));
    try {
      const configPath = path.join(stateDir, 'openclaw.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { entries: { main: {} }, defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } } } },
          skills: {
            entries: {
              'extension-skill': { env: { PRESERVE: 'fixture' } },
              unrelated: { enabled: false },
            },
          },
        }),
      );
      const script = String.raw`
      import fs from 'node:fs';
      import path from 'node:path';
      import { pathToFileURL } from 'node:url';
      const dist = path.join(process.cwd(), 'dist');
      const findModule = async (prefix, declaration) => {
        const file = fs.readdirSync(dist).find(file => file.startsWith(prefix) && file.endsWith('.mjs') && fs.readFileSync(path.join(dist, file), 'utf8').includes(declaration));
        if (!file) throw new Error('Required native skill export unavailable');
        return import(pathToFileURL(path.join(dist, file)).href);
      };
      const { skillsHandlers } = await findModule('skills-', 'const skillsHandlers =');
      const statusModule = await findModule('status-', 'function buildWorkspaceSkillStatus(');
      const buildStatus = Object.values(statusModule).find(value => typeof value === 'function' && value.name === 'buildWorkspaceSkillStatus');
      if (!buildStatus) throw new Error('Native skill status export unavailable');
      const baseDir = path.join(process.env.OPENCLAW_STATE_DIR, 'plugin-skills', 'extension-skill');
      const entry = { skill: { name: 'extension-skill', description: 'Fixture', source: 'openclaw-extra', filePath: path.join(baseDir, 'SKILL.md'), baseDir }, frontmatter: {} };
      const results = [];
      for (const enabled of [false, true]) {
        let response;
        await skillsHandlers['skills.update']({ params: { skillKey: 'extension-skill', enabled }, respond: (ok, result, error) => { response = { ok, result, error }; } });
        if (!response?.ok) throw new Error('Native skill update rejected');
        const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, 'utf8'));
        const report = buildStatus(process.env.OPENCLAW_STATE_DIR, { config, entries: [entry], files: [], managedSkillsDir: path.join(process.env.OPENCLAW_STATE_DIR, 'skills') });
        const skill = report.skills.find(skill => skill.skillKey === 'extension-skill');
        results.push({ source: skill.source, disabled: skill.disabled, eligible: skill.eligible, settings: config.skills.entries });
      }
      process.stdout.write('NATIVE_SKILL_SWITCH=' + JSON.stringify(results));
    `;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: runtimeRoot,
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      });
      const marker = 'NATIVE_SKILL_SWITCH=';
      const offset = stdout.lastIndexOf(marker);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(stdout.slice(offset + marker.length))).toEqual(
        [false, true].map(enabled => ({
          source: 'openclaw-extra',
          disabled: !enabled,
          eligible: enabled,
          settings: {
            'extension-skill': { env: { PRESERVE: 'fixture' }, enabled },
            unrelated: { enabled: false },
          },
        })),
      );
    } finally {
      expect(path.dirname(path.resolve(stateDir))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(stateDir).startsWith('skill-native-switch-')).toBe(true);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
  40_000,
);
