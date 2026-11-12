import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/037-project-skill-precedence.cjs');
const { CONTRACT, TARGET, transform } = patch.__testing;

const pristine = `function mergeSkillTiers(tiers, opts, libraryEntries = opts?.librarySelections?.length ? loadSkillLibrarySelection(opts.librarySelections) : []) {
  const select = (entries) => entries.filter((entry) => !opts?.matchesSnapshotSkill || opts.matchesSnapshotSkill(entry.skill));
  const collisions = [];
  const entries = mergeSkillRecords(mergeRemoteNodeSkillEntries(select(tiers.agent), opts?.eligibility?.nodeSkills, opts?.matchesSnapshotSkill), tiers.sourceKey, collisions);
  if (tiers.execution.length > 0) appendLowerPrecedenceSkillRecords(entries, mergeSkillRecords(select(tiers.execution), tiers.sourceKey, collisions), (winner, loser) => {
    if (canonicalizePath(winner.skill.filePath) !== canonicalizePath(loser.skill.filePath)) collisions.push({
      winner: winner.skill,
      loser: loser.skill
    });
  });
  if (!opts?.matchesSnapshotSkill) reportSkillPrecedenceCollisions(collisions, tiers.sourceKey);
  entries.push(...select(libraryEntries));
  return entries;
}`;
const frozen = pristine
  .replace(/\bselect\b/g, 'select3')
  .replace(/\bentries\b/g, 'entries4')
  .replace('(entries4) => entries4.filter((entry)', '(entries5) => entries5.filter((entry2)')
  .replace('matchesSnapshotSkill(entry.skill)', 'matchesSnapshotSkill(entry2.skill)');
const read = (file: string) => fs.readFileSync(file, 'utf8');

function withRuntime(run: (runtime: string, source: string, bundle: string) => void) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'project-skill-precedence-'));
  try {
    const source = path.join(runtime, TARGET);
    const bundle = path.join(runtime, 'gateway-bundle.mjs');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, pristine);
    fs.writeFileSync(bundle, frozen);
    run(runtime, source, bundle);
  } finally {
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

test('verifies both owners when the Gateway bundle omits the patch comment', () => {
  withRuntime((runtime, source, bundle) => {
    expect(() => patch.verifyPatch(runtime)).toThrow('Project skill precedence is missing');

    expect(patch.applyPatch(runtime).sort()).toEqual([
      path.normalize(TARGET),
      'gateway-bundle.mjs',
    ]);
    const patchedSource = read(source);
    const bundled = read(bundle).replace(`/*${CONTRACT}*/ `, '');
    fs.writeFileSync(bundle, bundled);

    expect(() => patch.verifyPatch(runtime)).not.toThrow();
    expect(patch.applyPatch(runtime)).toEqual([]);
    expect(read(source)).toBe(patchedSource);
    expect(read(bundle)).toBe(bundled);
  });
});

test('rejects mixed source and bundle states before writing either owner', () => {
  withRuntime((runtime, source, bundle) => {
    const patchedSource = transform(pristine);
    fs.writeFileSync(source, patchedSource);

    expect(() => patch.applyPatch(runtime)).toThrow('Mixed source/bundle project skill precedence');
    expect(read(source)).toBe(patchedSource);
    expect(read(bundle)).toBe(frozen);
  });
});

test('rejects historical markers, partial semantics and a marker-free published owner', () => {
  const current = transform(pristine);
  const damaged = current.replace('entries.push(...select(libraryEntries));', 'entries.push(...libraryEntries);');
  expect(() => transform(current.replace('V2026_10_7', 'V2026_10_6'))).toThrow('historical');
  expect(() => transform(damaged)).toThrow('partial or changed skill precedence');
  expect(() => transform(current.replace(`/*${CONTRACT}*/ `, ''))).toThrow('partial or changed skill precedence');
});
