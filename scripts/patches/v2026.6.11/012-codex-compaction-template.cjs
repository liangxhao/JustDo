'use strict';

// Purpose: Make OpenClaw safeguard compaction use Codex's continuation-handoff
// prompt instead of OpenClaw's required ## Goal / ## Progress template.
// Affected OpenClaw version: v2026.6.11.
// Risk: Upstream changes to the bundled prompt constants or safeguard assembly
// require these exact patch points to be updated.
// Upgrade action: Do not copy this patch into a new OpenClaw version directory.
// Re-audit the SDK prompt/wrapper constants and compaction-safeguard assembly,
// then rewrite the exact anchors and verify first, repeated, and split-turn
// summaries against the current Codex compaction sources.
// Depends on: 011-retain-user-messages-across-compaction.cjs, which is applied
// first by filename order and injects sanitizeCompactionSummaryMessages.
// Remove when: OpenClaw supports replacing (not merely extending) its
// compaction prompt, replay wrapper, and post-summary sections through config.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const CODEX_COMPACTION_MARKER = 'You are performing a CONTEXT CHECKPOINT COMPACTION.';

const ORIGINAL_COMPACTION_SUMMARY_WRAPPER = `    COMPACTION_SUMMARY_PREFIX = \`The conversation history before this point was compacted into the following summary:

<summary>
\`;
    COMPACTION_SUMMARY_SUFFIX = \`
</summary>\`;`;

const PATCHED_COMPACTION_SUMMARY_WRAPPER = `    COMPACTION_SUMMARY_PREFIX = \`Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:
\`;
    COMPACTION_SUMMARY_SUFFIX = \`\`;`;

const ORIGINAL_SUMMARIZATION_SYSTEM_PROMPT = `    SUMMARIZATION_SYSTEM_PROMPT = \`You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.\`;`;

const PATCHED_SUMMARIZATION_SYSTEM_PROMPT = `    SUMMARIZATION_SYSTEM_PROMPT = \`You are a context summarization assistant. Read the conversation and produce only the continuation handoff requested by the compaction instructions. Do not continue the conversation or answer its questions.\`;`;

const ORIGINAL_SUMMARIZATION_PROMPT = `    SUMMARIZATION_PROMPT = \`The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.\`;`;

const PATCHED_SUMMARIZATION_PROMPT = `    SUMMARIZATION_PROMPT = \`${CODEX_COMPACTION_MARKER} Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\`;`;

const ORIGINAL_UPDATE_SUMMARIZATION_PROMPT = `    UPDATE_SUMMARIZATION_PROMPT = \`The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.\`;`;

const PATCHED_UPDATE_SUMMARIZATION_PROMPT = `    UPDATE_SUMMARIZATION_PROMPT = \`${CODEX_COMPACTION_MARKER} Update the existing handoff summary in <previous-summary> with the new conversation messages so another LLM can resume the task.

Preserve still-relevant progress, decisions, constraints, user preferences, critical data, examples, references, and exact identifiers. Correct stale details, remove superseded or duplicate information, and state concrete next steps. Be concise and use the conversation language where practical.\`;`;

const ORIGINAL_TURN_PREFIX_SUMMARIZATION_PROMPT = `    TURN_PREFIX_SUMMARIZATION_PROMPT = \`This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.\`;`;

const PATCHED_TURN_PREFIX_SUMMARIZATION_PROMPT = `    TURN_PREFIX_SUMMARIZATION_PROMPT = \`${CODEX_COMPACTION_MARKER} Summarize this prefix of a split turn as continuation context for the retained suffix.

Preserve the original request, early progress, key decisions, constraints, user preferences, critical data, examples, references, and exact identifiers needed to understand and continue the retained work. Be concise and use the conversation language where practical.\`;`;

const ORIGINAL_STRUCTURED_FALLBACK = `function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  if (trimmedPreviousSummary && hasRequiredSummarySections(trimmedPreviousSummary)) return trimmedPreviousSummary;
  return [
    "## Decisions",
    trimmedPreviousSummary || "No prior history.",
    "",
    "## Open TODOs",
    "None.",
    "",
    "## Constraints/Rules",
    "None.",
    "",
    "## Pending user asks",
    "None.",
    "",
    "## Exact identifiers",
    "None captured."
  ].join("\\n");
}`;

const PATCHED_STRUCTURED_FALLBACK = `function buildStructuredFallbackSummary(previousSummary, _summarizationInstructions) {
  const trimmedPreviousSummary = previousSummary?.trim() ?? "";
  return trimmedPreviousSummary || "No prior conversation content was available to summarize.";
}`;

const ORIGINAL_SAFE_GUARD_SETUP = `    const identifierPolicy = runtime3?.identifierPolicy ?? "strict";
    const providerId = runtime3?.provider;
    const turnPrefixMessages = baseTurnPrefixMessages;
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime3?.recentTurnsPreserve);`;
const PATCHED_SAFE_GUARD_SETUP = `    const identifierPolicy = runtime3?.identifierPolicy ?? "strict";
    const providerId = runtime3?.provider;
    const codexStyleCompaction = customInstructions.startsWith("${CODEX_COMPACTION_MARKER}");
    let turnPrefixMessages = baseTurnPrefixMessages;
    if (codexStyleCompaction && turnPrefixMessages.length > 0) {
      baseMessagesToSummarize = sanitizeCompactionSummaryMessages([...baseMessagesToSummarize, ...turnPrefixMessages]);
      turnPrefixMessages = [];
    }
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime3?.recentTurnsPreserve);`;

const ORIGINAL_STRUCTURED_INSTRUCTIONS =
  '    const structuredInstructions = buildCompactionStructureInstructions(customInstructions, summarizationInstructions);';
const PREVIOUS_PATCHED_STRUCTURED_INSTRUCTIONS =
  '    const structuredInstructions = codexStyleCompaction ? customInstructions : buildCompactionStructureInstructions(customInstructions, summarizationInstructions);';
const PATCHED_STRUCTURED_INSTRUCTIONS =
  '    const structuredInstructions = codexStyleCompaction ? providerId ? customInstructions : void 0 : buildCompactionStructureInstructions(customInstructions, summarizationInstructions);';

const ORIGINAL_ASSEMBLE_SUFFIX = `function assembleSuffix(parts2) {
  let suffix = "";`;
const PATCHED_ASSEMBLE_SUFFIX = `function assembleSuffix(parts2) {
  if (parts2?.codexStyle === true) return "";
  let suffix = "";`;

const ORIGINAL_PROVIDER_SUFFIX = `          summary: capCompactionSummaryPreservingSuffix(providerResult, assembleSuffix({
            splitTurnSection,`;
const PATCHED_PROVIDER_SUFFIX = `          summary: capCompactionSummaryPreservingSuffix(providerResult, assembleSuffix({
            codexStyle: codexStyleCompaction,
            splitTurnSection,`;

const ORIGINAL_LLM_SUFFIX = `      const suffix = assembleSuffix({
        splitTurnSection: lastSplitTurnSection,`;
const PATCHED_LLM_SUFFIX = `      const suffix = assembleSuffix({
        codexStyle: codexStyleCompaction,
        splitTurnSection: lastSplitTurnSection,`;

function replaceExactlyOnce(content, original, replacement, description, filePath) {
  const firstIndex = content.indexOf(original);
  if (firstIndex === -1) {
    throw new Error(`OpenClaw ${description} patch target not found: ${filePath}`);
  }
  if (content.indexOf(original, firstIndex + original.length) !== -1) {
    throw new Error(`OpenClaw ${description} patch target is ambiguous: ${filePath}`);
  }
  return content.replace(original, replacement);
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (
    content.includes(PREVIOUS_PATCHED_STRUCTURED_INSTRUCTIONS) &&
    !content.includes(PATCHED_STRUCTURED_INSTRUCTIONS)
  ) {
    content = content.replace(
      PREVIOUS_PATCHED_STRUCTURED_INSTRUCTIONS,
      ORIGINAL_STRUCTURED_INSTRUCTIONS,
    );
  }
  const targets = [
    [
      ORIGINAL_COMPACTION_SUMMARY_WRAPPER,
      PATCHED_COMPACTION_SUMMARY_WRAPPER,
      'Codex compaction summary wrapper',
    ],
    [
      ORIGINAL_SUMMARIZATION_SYSTEM_PROMPT,
      PATCHED_SUMMARIZATION_SYSTEM_PROMPT,
      'Codex summarization system prompt',
    ],
    [ORIGINAL_SUMMARIZATION_PROMPT, PATCHED_SUMMARIZATION_PROMPT, 'Codex compaction prompt'],
    [
      ORIGINAL_UPDATE_SUMMARIZATION_PROMPT,
      PATCHED_UPDATE_SUMMARIZATION_PROMPT,
      'Codex repeated-compaction prompt',
    ],
    [
      ORIGINAL_TURN_PREFIX_SUMMARIZATION_PROMPT,
      PATCHED_TURN_PREFIX_SUMMARIZATION_PROMPT,
      'Codex split-turn compaction prompt',
    ],
    [ORIGINAL_STRUCTURED_FALLBACK, PATCHED_STRUCTURED_FALLBACK, 'Codex empty fallback'],
    [ORIGINAL_SAFE_GUARD_SETUP, PATCHED_SAFE_GUARD_SETUP, 'Codex safeguard setup'],
    [ORIGINAL_STRUCTURED_INSTRUCTIONS, PATCHED_STRUCTURED_INSTRUCTIONS, 'Codex structure bypass'],
    [ORIGINAL_ASSEMBLE_SUFFIX, PATCHED_ASSEMBLE_SUFFIX, 'Codex suffix bypass'],
    [ORIGINAL_PROVIDER_SUFFIX, PATCHED_PROVIDER_SUFFIX, 'Codex provider suffix marker'],
    [ORIGINAL_LLM_SUFFIX, PATCHED_LLM_SUFFIX, 'Codex LLM suffix marker'],
  ];

  const alreadyPatched = targets.every(([, replacement]) => content.includes(replacement));
  if (alreadyPatched) return false;

  for (const [original, replacement, description] of targets) {
    if (content.includes(replacement)) continue;
    content = replaceExactlyOnce(content, original, replacement, description, filePath);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-codex-compaction-template';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring compaction patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Replaced OpenClaw compaction format with Codex handoff prompts.`);
  } else if (options.verbose) {
    console.log(`[${label}] Codex compaction template already applied.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    PATCHED_COMPACTION_SUMMARY_WRAPPER,
    PATCHED_SUMMARIZATION_SYSTEM_PROMPT,
    PATCHED_SUMMARIZATION_PROMPT,
    PATCHED_UPDATE_SUMMARIZATION_PROMPT,
    PATCHED_TURN_PREFIX_SUMMARIZATION_PROMPT,
    PATCHED_STRUCTURED_FALLBACK,
    PATCHED_SAFE_GUARD_SETUP,
    PATCHED_STRUCTURED_INSTRUCTIONS,
    PATCHED_ASSEMBLE_SUFFIX,
    PATCHED_PROVIDER_SUFFIX,
    PATCHED_LLM_SUFFIX,
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) throw new Error(`Codex compaction template patch is incomplete: ${missing.length} replacement(s) missing`);
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  CODEX_COMPACTION_MARKER,
  __testing: {
    ORIGINAL_COMPACTION_SUMMARY_WRAPPER,
    ORIGINAL_SUMMARIZATION_SYSTEM_PROMPT,
    ORIGINAL_SUMMARIZATION_PROMPT,
    ORIGINAL_UPDATE_SUMMARIZATION_PROMPT,
    ORIGINAL_TURN_PREFIX_SUMMARIZATION_PROMPT,
    ORIGINAL_STRUCTURED_FALLBACK,
    ORIGINAL_SAFE_GUARD_SETUP,
    ORIGINAL_STRUCTURED_INSTRUCTIONS,
    ORIGINAL_ASSEMBLE_SUFFIX,
    ORIGINAL_PROVIDER_SUFFIX,
    ORIGINAL_LLM_SUFFIX,
  },
};
