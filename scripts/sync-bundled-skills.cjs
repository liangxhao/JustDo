'use strict';

const fs = require('fs');
const path = require('path');

function readBundledSkillConfig(repoRoot) {
  const configPath = path.join(repoRoot, 'resources', 'builtin-skills.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing bundled skill manifest: ${configPath}`);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.skills)) {
    throw new Error(`Invalid bundled skill manifest, "skills" must be an array: ${configPath}`);
  }

  const enabledSkillIds = config.skills
    .filter(skill => skill?.enabled)
    .map(skill => String(skill.id || '').trim());
  if (enabledSkillIds.some(skillId => !skillId)) {
    throw new Error(`Invalid empty skill id in bundled skill manifest: ${configPath}`);
  }
  if (new Set(enabledSkillIds).size !== enabledSkillIds.length) {
    throw new Error(`Duplicate enabled skill ids in bundled skill manifest: ${configPath}`);
  }

  return {
    configPath,
    disableOpenClawDefaults: config.disableOpenClawDefaults === true,
    enabledSkillIds,
  };
}

function syncBundledSkills(repoRoot, runtimeRoot, label = 'sync-bundled-skills') {
  const { disableOpenClawDefaults, enabledSkillIds } = readBundledSkillConfig(repoRoot);
  const sourceRoot = path.join(repoRoot, 'resources', 'skills');
  const runtimeSkillsRoot = path.join(runtimeRoot, 'skills');

  for (const skillId of enabledSkillIds) {
    const sourceSkillRoot = path.join(sourceRoot, skillId);
    if (!fs.existsSync(path.join(sourceSkillRoot, 'SKILL.md'))) {
      throw new Error(`[${label}] Bundled skill is missing SKILL.md: ${sourceSkillRoot}`);
    }
  }

  if (disableOpenClawDefaults) {
    fs.rmSync(runtimeSkillsRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeSkillsRoot, { recursive: true });

  for (const skillId of enabledSkillIds) {
    fs.cpSync(path.join(sourceRoot, skillId), path.join(runtimeSkillsRoot, skillId), {
      recursive: true,
      force: true,
    });
  }

  if (disableOpenClawDefaults) {
    const actualSkillIds = fs
      .readdirSync(runtimeSkillsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    const expectedSkillIds = [...enabledSkillIds].sort();
    if (JSON.stringify(actualSkillIds) !== JSON.stringify(expectedSkillIds)) {
      throw new Error(
        `[${label}] Runtime skills do not match the enabled manifest. ` +
          `Expected: ${expectedSkillIds.join(', ') || '(none)'}. ` +
          `Actual: ${actualSkillIds.join(', ') || '(none)'}.`,
      );
    }
  }

  console.log(`[${label}] Synced ${enabledSkillIds.length} bundled skills into the runtime.`);
  return enabledSkillIds;
}

module.exports = { readBundledSkillConfig, syncBundledSkills };
