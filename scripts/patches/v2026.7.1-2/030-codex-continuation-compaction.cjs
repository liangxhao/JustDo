'use strict';

// Capability: use a Codex-style continuation handoff for first, repeated and split compaction.
// Target: pristine openclaw@2026.7.1-2 default templates and compaction replay wrapper.
// Scope: changes only default wording/wrapper while retaining customInstructions composition.
// Safety: quality repair, exact identifiers, suffix limits and workspace context remain upstream.
// Remove when: OpenClaw exposes default-template and replay-wrapper replacement through config.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const MARKER = 'You are performing a CONTEXT CHECKPOINT COMPACTION.';

function transformSafeguard(content, filePath) {
  if (content.includes(MARKER)) return content;
  let out = replaceUniquePattern(
    content,
    /"Write the summary body in the primary language used in the conversation\.\\nFocus on factual content:[^"\n]*(?:\\n[^"\n]*){2}"/,
    `"${MARKER}\\nCreate a concise continuation handoff in the conversation language. Preserve progress, decisions, constraints, unresolved user asks, next steps, and exact identifiers."`,
    `${filePath}: default customInstructions`,
  );
  out = replaceUniquePattern(
    out,
    /"Produce a compact, factual summary with these exact section headings:"/,
    '"Produce a continuation handoff for the next model with these exact section headings:"',
    `${filePath}: continuation structure`,
  );
  return out;
}

function transformCore(content, filePath) {
  if (content.includes('Another language model started to solve this problem')) return content;
  let out = replaceUniquePattern(
    content,
    /const COMPACTION_SUMMARY_PREFIX = `[\s\S]*?`;\s*const COMPACTION_SUMMARY_SUFFIX = `[\s\S]*?`;/,
    'const COMPACTION_SUMMARY_PREFIX = `Another language model started to solve this problem and produced a continuation handoff. Use it to continue the work without duplicating completed steps:\n\n`;\nconst COMPACTION_SUMMARY_SUFFIX = ``;',
    `${filePath}: replay wrapper`,
  );
  out = replaceUniquePattern(
    out,
    /const SUMMARIZATION_PROMPT = `[\s\S]*?`;\s*const UPDATE_SUMMARIZATION_PROMPT = `[\s\S]*?`;/,
    `const SUMMARIZATION_PROMPT = \`${MARKER} Create a handoff for another model that will resume the task. Include current progress, decisions, constraints, unresolved asks, concrete next steps, critical context and exact identifiers. Be concise.\`;
const UPDATE_SUMMARIZATION_PROMPT = \`${MARKER} Re-distill the existing handoff with the new messages. Preserve still-relevant facts, remove stale duplicates, and state concrete next steps for the next model.\`;`,
    `${filePath}: first and repeated templates`,
  );
  out = replaceUniquePattern(
    out,
    /const TURN_PREFIX_SUMMARIZATION_PROMPT = `[\s\S]*?`;/,
    `const TURN_PREFIX_SUMMARIZATION_PROMPT = \`${MARKER} Summarize this prefix of a split turn as continuation context for the retained suffix. Preserve the original request, early progress, decisions, constraints and exact identifiers needed to continue.\`;`,
    `${filePath}: split-turn template`,
  );
  return out;
}

function applyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  let safeguards = findFilesContaining(runtimeDir, [
    'function resolveCompactionInstructions(',
    'Produce a compact, factual summary with these exact section headings',
  ]);
  if (safeguards.length === 0)
    safeguards = findFilesContaining(runtimeDir, [
      'function resolveCompactionInstructions(',
      MARKER,
    ]);
  let cores = findFilesContaining(runtimeDir, [
    'const COMPACTION_SUMMARY_PREFIX = `The conversation history',
    'const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX',
  ]);
  if (cores.length === 0)
    cores = findFilesContaining(runtimeDir, [
      'Another language model started to solve this problem',
      MARKER,
    ]);
  if (safeguards.length !== expected || cores.length !== expected)
    throw new Error(
      `Codex compaction targets safeguard=${safeguards.length}, core=${cores.length}, expected=${expected}`,
    );
  const transforms = new Map();
  for (const [filePath, transform] of [
    ...safeguards.map(p => [p, transformSafeguard]),
    ...cores.map(p => [p, transformCore]),
  ]) {
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  }
  const staged = [...transforms].map(([filePath, fileTransforms]) => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, filePath),
      original,
    );
    return { filePath, original, updated };
  });
  return staged
    .filter(x => writeIfChanged(x.filePath, x.original, x.updated))
    .map(x => path.relative(runtimeDir, x.filePath));
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const safeguards = findFilesContaining(runtimeDir, [
    'function resolveCompactionInstructions(',
    MARKER,
  ]);
  const cores = findFilesContaining(runtimeDir, [
    'Another language model started to solve this problem',
    MARKER,
  ]);
  if (safeguards.length !== expected || cores.length !== expected)
    throw new Error(
      `Codex continuation target count safeguard=${safeguards.length}, core=${cores.length}, expected=${expected}`,
    );
  for (const p of [...new Set([...safeguards, ...cores])]) {
    const c = fs.readFileSync(p, 'utf8');
    if (
      c.includes('COMPACTION_SUMMARY_PREFIX') &&
      !c.includes('Another language model started to solve this problem')
    )
      throw new Error(`${p}: replay wrapper missing`);
    if (
      c.includes('buildCompactionStructureInstructions') &&
      (!c.includes('...REQUIRED_SUMMARY_SECTIONS') || !c.includes('wrapUntrustedInstructionBlock'))
    )
      throw new Error(`${p}: upstream quality/custom-instruction flow was lost`);
  }
}
module.exports = { applyPatch, verifyPatch };
