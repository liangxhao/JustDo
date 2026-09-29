'use strict';

const fs = require('fs');
const path = require('path');

function readBundledSkillConfig(repoRoot) {
  const configPath = path.join(repoRoot, 'resources', 'builtin-skills.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const invalid = message => {
    throw new Error(`Invalid bundled skill manifest (${configPath}): ${message}`);
  };
  if (config.version !== 2 || Object.hasOwn(config, 'disableOpenClawDefaults')) {
    invalid('expected version 2 with explicit OpenClaw allowlists');
  }
  const validateIds = (ids, field) => {
    if (
      !Array.isArray(ids) ||
      ids.some(id => typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
    ) {
      invalid(`${field} must contain safe skill ids`);
    }
    if (new Set(ids).size !== ids.length) invalid(`duplicate ids in ${field}`);
    return ids;
  };
  if (
    !Array.isArray(config.skills) ||
    config.skills.some(skill => !skill || typeof skill.enabled !== 'boolean')
  ) {
    invalid('skills must contain id/enabled entries');
  }
  validateIds(
    config.skills.map(skill => skill.id),
    'skills',
  );
  const enabledSkillIds = config.skills.filter(skill => skill.enabled).map(skill => skill.id);
  const openclawSkillIds = validateIds(config.openclaw?.skills, 'openclaw.skills');
  const custodianSkillIds = validateIds(
    config.openclaw?.custodianSkills,
    'openclaw.custodianSkills',
  );
  validateIds(
    [...enabledSkillIds, ...openclawSkillIds, ...custodianSkillIds],
    'selected skills across sources',
  );
  const runtimeSkillPaths = [
    ...[...enabledSkillIds, ...openclawSkillIds].map(id => `skills/${id}`),
    ...custodianSkillIds.map(id => `custodian-skills/${id}`),
  ];
  return { configPath, enabledSkillIds, openclawSkillIds, custodianSkillIds, runtimeSkillPaths };
}

function syncBundledSkills(repoRoot, runtimeRoot, label = 'sync-bundled-skills') {
  const { enabledSkillIds, openclawSkillIds, custodianSkillIds } = readBundledSkillConfig(repoRoot);
  const sourceRoot = path.join(repoRoot, 'resources', 'skills');
  // Validate every source before pruning anything. Previously pruned upstream
  // skills must be restored by rebuilding from the locked pristine package.
  const requiredRoots = [
    ...enabledSkillIds.map(id => path.join(sourceRoot, id)),
    ...openclawSkillIds.map(id => path.join(runtimeRoot, 'skills', id)),
    ...custodianSkillIds.map(id => path.join(runtimeRoot, 'custodian-skills', id)),
  ];
  for (const root of requiredRoots) {
    if (!fs.existsSync(path.join(root, 'SKILL.md'))) {
      throw new Error(
        `[${label}] Selected skill is missing SKILL.md: ${root}. Rebuild the runtime from the locked pristine OpenClaw package if an upstream skill was previously pruned.`,
      );
    }
  }
  const prune = (directory, ids) => {
    const root = path.resolve(runtimeRoot, directory);
    const keep = new Set(ids);
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (keep.has(entry.name)) continue;
      const target = path.resolve(root, entry.name);
      if (path.dirname(target) !== root) throw new Error(`Unsafe skill path: ${target}`);
      fs.rmSync(target, { recursive: true, force: true });
    }
  };
  // Local skills are replaced completely so removed support files do not linger.
  prune('skills', openclawSkillIds);
  prune('custodian-skills', custodianSkillIds);
  for (const id of enabledSkillIds) {
    fs.cpSync(path.join(sourceRoot, id), path.join(runtimeRoot, 'skills', id), { recursive: true });
  }
  console.log(
    `[${label}] Synced ${enabledSkillIds.length} local, ${openclawSkillIds.length} upstream and ${custodianSkillIds.length} custodian skills.`,
  );
  return enabledSkillIds;
}

module.exports = { readBundledSkillConfig, syncBundledSkills };
