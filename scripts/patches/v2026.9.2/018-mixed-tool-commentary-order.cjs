'use strict';

// Capability: retain commentary at its original position among Thinking and Tools in history.
// Target: openclaw@2026.9.2 native chat history sanitization.
// Scope: opted-in commentary recovery for mixed assistant Tool messages only.
// Safety: reuse native fallback admission, sanitization, truncation, and visibility guards.
// Remove when: upstream mixed Tool history preserves commentary block order directly.

const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');
const ts = require('typescript');
const { findFilesContaining, findMatchingDelimiter, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_ORDERED_COMMENTARY_HISTORY_V2026_9_2';
const ORIGINAL_NAME = 'sanitizeChatHistoryMessages';
// Exact locked npm worker artifact (its locals are pre-minified).
const NATIVE_WORKER =
  'function sanitizeChatHistoryMessages(Ot,Zt=DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,_n){if(Ot.length===0)return Ot;let Dn=!1,kn=[];for(let Pn of Ot){if(_n?.includeCommentaryFallbacks===!0)for(let Ot of projectAssistantCommentaryFallbacks(Pn,Zt)){let _n=sanitizeChatHistoryMessage(Ot,Zt);kn.push(_n.message),Dn=!0}if(shouldDropAssistantHistoryMessage(Pn)){Dn=!0;continue}let Ot=sanitizeChatHistoryMessage(Pn,Zt);if(Dn||=Ot.changed,Ot.changed&&shouldDropAssistantHistoryMessage(Ot.message)){Dn=!0;continue}kn.push(Ot.message)}return Dn?kn:Ot}';

function nativeSanitize(messages, maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS, opts) {
  if (messages.length === 0) return messages;
  let changed = false;
  const next = [];
  for (const message of messages) {
    if (opts?.includeCommentaryFallbacks === true)
      for (const commentary of projectAssistantCommentaryFallbacks(message, maxChars)) {
        const projected = sanitizeChatHistoryMessage(commentary, maxChars);
        next.push(projected.message);
        changed = true;
      }
    if (shouldDropAssistantHistoryMessage(message)) {
      changed = true;
      continue;
    }
    const res = sanitizeChatHistoryMessage(message, maxChars);
    changed ||= res.changed;
    if (res.changed && shouldDropAssistantHistoryMessage(res.message)) {
      changed = true;
      continue;
    }
    next.push(res.message);
  }
  return changed ? next : messages;
}

function sanitizeChatHistoryMessages(
  messages,
  maxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  opts,
) {
  if (opts?.includeCommentaryFallbacks !== true)
    return JUSTDO_ORDERED_COMMENTARY_HISTORY_V2026_9_2(messages, maxChars, opts);
  let changed = false;
  const next = [];
  for (const message of messages) {
    let ordered = message;
    if (
      message &&
      typeof message === 'object' &&
      message.role === 'assistant' &&
      message.display !== false &&
      Array.isArray(message.content) &&
      message.content.some(
        block => block && typeof block === 'object' && isToolHistoryBlockType(block.type),
      )
    ) {
      const fallbacks = projectAssistantCommentaryFallbacks(message, maxChars);
      if (fallbacks.length > 0) {
        let cursor = 0;
        let truncated = false;
        let reason;
        const content = message.content.map(block => {
          if (!block || typeof block !== 'object' || !isAssistantTextContentType(block.type))
            return block;
          const signature = parseAssistantTextSignature(block);
          if (
            signature?.phase !== 'commentary' ||
            typeof block.text !== 'string' ||
            !block.text.trim()
          )
            return block;
          const fallback = fallbacks[cursor];
          if (!fallback || fallback.openclawStreamFallback?.itemId !== signature.id?.trim())
            return block;
          cursor += 1;
          const safe = sanitizeChatHistoryMessage(fallback, maxChars).message;
          if (safe.__openclaw?.truncated === true) {
            truncated = true;
            reason ??= safe.__openclaw.reason;
          }
          const text = Array.isArray(safe.content)
            ? safe.content
                .filter(item => item && item.type === 'text' && typeof item.text === 'string')
                .map(item => item.text)
                .join('')
            : '';
          return { type: 'text', text };
        });
        // Fall back to the exact native path if an unexpected signature cannot
        // be paired. Duplicate IDs are paired by occurrence, never by a Map.
        if (cursor === fallbacks.length) {
          ordered = {
            ...message,
            content,
            ...(truncated
              ? {
                  __openclaw: {
                    ...message.__openclaw,
                    truncated: true,
                    reason: message.__openclaw?.reason ?? reason ?? 'display-cap',
                  },
                }
              : {}),
          };
        }
      }
    }
    const projected = JUSTDO_ORDERED_COMMENTARY_HISTORY_V2026_9_2(
      [ordered],
      maxChars,
      ordered === message && message?.display !== false ? opts : undefined,
    );
    changed ||= ordered !== message || projected.length !== 1 || projected[0] !== message;
    next.push(...projected);
  }
  return changed ? next : messages;
}

function compact(source) {
  return transformSync(source, {
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: 'none',
    target: 'esnext',
  }).code;
}

const canonicalCache = new Map();
function canonical(source, name) {
  const normalized = compact(
    source.replace(new RegExp(`function ${name}\\(`, 'u'), 'function canonicalHistory('),
  );
  if (canonicalCache.has(normalized)) return canonicalCache.get(normalized);
  // Resolve lexical bindings instead of guessing that suffixed tokens are locals.
  // Property names (including optional access and object keys) are part of the
  // exact behavioral contract and must never be normalized with local names.
  const filename = 'canonical-history.js';
  const tree = ts.createSourceFile(
    filename,
    normalized,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  const options = { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => (file === filename ? tree : undefined);
  const program = ts.createProgram([filename], options, host);
  const checker = program.getTypeChecker();
  const bindings = new Map();
  const bind = nameNode => {
    if (!ts.isIdentifier(nameNode)) throw new Error('Unsupported native history binding pattern');
    const symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) throw new Error('Unresolved native history binding');
    // These comparison tokens cannot collide with any valid JavaScript global.
    if (!bindings.has(symbol)) bindings.set(symbol, `\u0000binding${bindings.size}\u0000`);
  };
  const collect = node => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const edits = [];
  const visit = node => {
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = checker.getShorthandAssignmentValueSymbol(node);
      const local = bindings.get(symbol);
      if (local)
        edits.push({
          start: node.name.getStart(tree),
          end: node.name.end,
          text: `${node.name.text}:${local}`,
        });
      return;
    }
    if (ts.isIdentifier(node)) {
      const local = bindings.get(checker.getSymbolAtLocation(node));
      if (local) edits.push({ start: node.getStart(tree), end: node.end, text: local });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  let result = normalized;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  if (canonicalCache.size >= 32) canonicalCache.clear();
  canonicalCache.set(normalized, result);
  return result;
}

function matchesFunction(actual, actualName, expected, expectedName) {
  const normalized = canonical(actual, actualName);
  return (
    normalized === canonical(expected, expectedName) ||
    (expectedName === 'nativeSanitize' && normalized === canonical(NATIVE_WORKER, ORIGINAL_NAME))
  );
}

function rangeOf(content, name, filePath) {
  const matches = [...content.matchAll(new RegExp(`function ${name}\\(`, 'gu'))];
  if (matches.length !== 1)
    throw new Error(`${filePath}: ${name} target count ${matches.length}, expected 1`);
  const start = matches[0].index;
  const parametersStart = start + matches[0][0].length - 1;
  const parametersEnd = findMatchingDelimiter(content, parametersStart, '(', ')', filePath);
  let bodyStart = parametersEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const end = findMatchingDelimiter(content, bodyStart, '{', '}', filePath) + 1;
  return { start, end, source: content.slice(start, end) };
}

function transform(content, filePath) {
  const original = rangeOf(content, ORIGINAL_NAME, filePath);
  if (content.includes(MARKER)) {
    const retained = rangeOf(content, MARKER, filePath);
    if (
      !matchesFunction(
        original.source,
        ORIGINAL_NAME,
        sanitizeChatHistoryMessages.toString(),
        ORIGINAL_NAME,
      ) ||
      !matchesFunction(retained.source, MARKER, nativeSanitize.toString(), 'nativeSanitize')
    ) {
      throw new Error(
        `${filePath}: historical or partial ordered commentary patch; rebuild pristine runtime`,
      );
    }
    return content;
  }
  if (
    content.includes('JUSTDO_ORDERED_COMMENTARY_HISTORY_') ||
    !matchesFunction(original.source, ORIGINAL_NAME, nativeSanitize.toString(), 'nativeSanitize')
  ) {
    throw new Error(`${filePath}: unexpected native history sanitizer; rebuild pristine runtime`);
  }
  const retained = original.source.replace(`function ${ORIGINAL_NAME}(`, `function ${MARKER}(`);
  return (
    content.slice(0, original.start) +
    retained +
    '\n' +
    sanitizeChatHistoryMessages.toString() +
    content.slice(original.end)
  );
}

function processTargets(runtimeDir, verify) {
  const files = findFilesContaining(runtimeDir, ['function sanitizeChatHistoryMessages(']);
  const expected =
    1 +
    Number(fs.existsSync(path.join(runtimeDir, 'dist', 'worker', 'worker.mjs'))) +
    Number(fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')));
  if (files.length !== expected)
    throw new Error(`ordered commentary targets ${files.length}, expected ${expected}`);
  const updates = files.map(file => {
    const original = fs.readFileSync(file, 'utf8');
    return { file, original, updated: transform(original, file) };
  });
  const states = updates.map(({ original, updated }) => original === updated);
  if (!verify && states.some(Boolean) && states.some(state => !state))
    throw new Error('partial ordered commentary patch; rebuild pristine runtime');
  const changed = [];
  for (const { file, original, updated } of updates) {
    if (verify && original !== updated)
      throw new Error(`${file}: ordered commentary patch missing`);
    if (!verify && writeIfChanged(file, original, updated))
      changed.push(path.relative(runtimeDir, file));
  }
  return changed;
}

module.exports = {
  applyPatch: runtimeDir => processTargets(runtimeDir, false),
  verifyPatch: runtimeDir => processTargets(runtimeDir, true),
  __testing: { MARKER, transform, rangeOf, nativeSanitize, sanitizeChatHistoryMessages },
};
