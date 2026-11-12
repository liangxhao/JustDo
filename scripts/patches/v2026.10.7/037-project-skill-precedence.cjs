'use strict';

// Capability: prefer the current execution directory's skills over same-named assistant skills.
// Target: pristine openclaw@2026.10.7 merges the execution directory as the lower tier.
// Scope: native skill tier merging in the published loader and frozen Gateway bundle.
// Safety: retain native source identity, snapshot selection, eligibility and Library pins.
// Remove when: OpenClaw supports execution-directory-first discovery with separate assistant homes.

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  countOccurrences,
  findFilesContaining,
  isGatewayBundlePath,
  readRuntimeTextFile,
  writeIfChanged,
} = require('./_patch-utils.js');
const { assertTargetPaths, functionRange, parse } = require('./prepared-read-patch-shapes.js');

const CONTRACT = 'RUNTIME_PROJECT_SKILL_PRECEDENCE_V2026_10_7';
const TARGET = 'dist/workspace-skill-loader-sfXVTUiF.mjs';
const OWNER = 'mergeSkillTiers';
const PRINTER = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

// The frozen bundle can rename these locals. The full owner is checked with
// the captured bindings, including the calls and unchanged collision callback.
const BINDINGS =
  /\r?\n([ \t]+)const (select\d*) = \((entries\d*)\) => \3\.filter\(\((entry\d*)\) => [^\r\n]+\r?\n\1const collisions = \[\];\r?\n\1const (entries\d*) = /u;

function mergeShape(bindings, projectFirst, marked = false) {
  const [, indent, select, candidates, candidate, entries] = bindings;
  const agent = `mergeSkillRecords(mergeRemoteNodeSkillEntries(${select}(tiers.agent), opts?.eligibility?.nodeSkills, opts?.matchesSnapshotSkill), tiers.sourceKey, collisions)`;
  const project = `mergeSkillRecords(${select}(tiers.execution), tiers.sourceKey, collisions)`;
  const guard = projectFirst ? '' : 'if (tiers.execution.length > 0) ';
  const marker = marked ? `/*${CONTRACT}*/ ` : '';
  return [
    `function ${OWNER}(tiers, opts, libraryEntries = opts?.librarySelections?.length ? loadSkillLibrarySelection(opts.librarySelections) : []) {`,
    `${indent}const ${select} = (${candidates}) => ${candidates}.filter((${candidate}) => !opts?.matchesSnapshotSkill || opts.matchesSnapshotSkill(${candidate}.skill));`,
    `${indent}const collisions = [];`,
    `${indent}const ${entries} = ${projectFirst ? project : agent};`,
    `${indent}${marker}${guard}appendLowerPrecedenceSkillRecords(${entries}, ${projectFirst ? agent : project}, (winner, loser) => {`,
    `${indent.repeat(2)}if (canonicalizePath(winner.skill.filePath) !== canonicalizePath(loser.skill.filePath)) collisions.push({`,
    `${indent.repeat(3)}winner: winner.skill,`,
    `${indent.repeat(3)}loser: loser.skill`,
    `${indent.repeat(2)}});`,
    `${indent}});`,
    `${indent}if (!opts?.matchesSnapshotSkill) reportSkillPrecedenceCollisions(collisions, tiers.sourceKey);`,
    `${indent}${entries}.push(...${select}(libraryEntries));`,
    `${indent}return ${entries};`,
    '}',
  ].join('\n');
}

function printOwner(source, file) {
  const ast = parse(source);
  if (ast.parseDiagnostics.length !== 0 || ast.statements.length !== 1 ||
      !ts.isFunctionDeclaration(ast.statements[0])) {
    throw new Error(`${file}: invalid skill merge owner`);
  }
  return PRINTER.printFile(ast);
}

function transform(source, file = TARGET) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const range = functionRange(source, OWNER);
  const bindings = range.text.match(BINDINGS);
  if (!bindings) throw new Error(`${file}: native skill merge bindings changed`);

  const markers = countOccurrences(source, CONTRACT);
  const actual = printOwner(range.text, file);
  if ((markers === 1 || (markers === 0 && isGatewayBundlePath(file))) &&
      actual === printOwner(mergeShape(bindings, true, markers === 1), file)) {
    return source;
  }

  if (markers !== 0 || actual !== printOwner(mergeShape(bindings, false), file)) {
    throw new Error(`${file}: historical, partial or changed skill precedence; rebuild pristine runtime`);
  }
  const replacement = mergeShape(bindings, true, true);
  return source.slice(0, range.start) +
    (range.text.includes('\r\n') ? replacement.replaceAll('\n', '\r\n') : replacement) +
    source.slice(range.end);
}

function processTargets(root, verify) {
  const bundle = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? ['gateway-bundle.mjs'] : [];
  const files = findFilesContaining(root, `function ${OWNER}(`);
  assertTargetPaths(root, files, [TARGET, ...bundle], 'project skill precedence');
  const plans = files.map(file => {
    const source = readRuntimeTextFile(file);
    return { file, source, next: transform(source, file) };
  });
  if (plans.some(plan => plan.source === plan.next) && plans.some(plan => plan.source !== plan.next)) {
    throw new Error('Mixed source/bundle project skill precedence; rebuild pristine runtime');
  }
  if (verify && plans.some(plan => plan.source !== plan.next)) {
    throw new Error('Project skill precedence is missing');
  }
  return verify ? [] : plans.filter(plan => writeIfChanged(plan.file, plan.source, plan.next))
    .map(plan => path.relative(root, plan.file));
}

module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, TARGET, CONTRACT },
};
