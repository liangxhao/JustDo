'use strict';

// Capability: deliver trusted local MEDIA files whose MIME type cannot be detected.
// Target: openclaw@2026.8.2 managed outgoing media preparation and HTTP disposition.
// Scope: trusted local generic downloads only.
// Safety: admission and size checks stay unchanged; remote and untrusted octet streams remain denied.
// Remove when: upstream safely downloads generic trusted local files.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_TRUSTED_LOCAL_FILE_MEDIA_DOWNLOAD_ONLY_V2026_8_2';
const DOCUMENT_SET_PATTERN =
  /\bMANAGED_DOCUMENT_MIME_TYPES\s*=\s*(?:\/\*[^*]*\*\/\s*)?new Set\(\[/gu;
const ORIGINAL_DOCUMENT_MIME_PATTERN =
  /(["'`])application\/json\1\s*,(\s*)(["'`])application\/pdf\3/gu;
const PATCHED_DOCUMENT_MIME_PATTERN =
  /(["'`])application\/json\1\s*,(\s*)(["'`])application\/octet-stream\3\s*,(\s*)(["'`])application\/pdf\5/gu;
const ORIGINAL_CONTENT_TYPE_PATTERN =
  /((?:(?:const|let)\s+|,)\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.contentType\s*\?\?\s*([A-Za-z_$][\w$]*)\.mimeType)\s*;/gu;
const PATCHED_CONTENT_TYPE_PATTERN =
  /((?:(?:const|let)\s+|,)\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.contentType\s*\?\?\s*([A-Za-z_$][\w$]*)\.mimeType)\s*\?\?\s*\(\s*([A-Za-z_$][\w$]*)\s*&&\s*\4\.trustedLocal\s*\?\s*(["'`])application\/octet-stream\6\s*:\s*(?:void\s+0|undefined)\s*\)\s*;(?:\/\*JUSTDO_TRUSTED_LOCAL_FILE_MEDIA_DOWNLOAD_ONLY_V2026_8_2\*\/)?/gu;
const ORIGINAL_KIND_GUARD_PATTERN =
  /((?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveManagedMediaKind\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;)\s*if\s*\(\s*!\2\s*\)\s*throw\s+(?:new\s+)?Error\(\s*(["'`])Managed media attachment has an unsupported content type\4\s*\)\s*;?/gu;
const PATCHED_KIND_GUARD_PATTERN =
  /((?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*resolveManagedMediaKind\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;)\s*if\s*\(\s*!\2\s*\|\|\s*\(?\s*normalizeMimeType\(\s*\3\s*\)\s*===\s*(["'`])application\/octet-stream\4\s*&&\s*!\(\s*([A-Za-z_$][\w$]*)\s*&&\s*([A-Za-z_$][\w$]*)\.trustedLocal\s*\)\s*\)?\s*\)\s*throw\s+(?:new\s+)?Error\(\s*(["'`])Managed media attachment has an unsupported content type\7\s*\)\s*;?/gu;
const ORIGINAL_DISPOSITION_PATTERN = /mediaKindFromMime\(\s*([A-Za-z_$][\w$]*)\s*\)/gu;
const PATCHED_DISPOSITION_PATTERN = /resolveManagedMediaKind\(\s*([A-Za-z_$][\w$]*)\s*\)/gu;

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function resolveManagedMediaKind(',
    'Managed media attachment has no detectable content type',
    'function buildManagedMediaContentDisposition(',
  ]);
}

function findDocumentMimeSet(content, filePath) {
  const matches = [...content.matchAll(DOCUMENT_SET_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(
      `${filePath}: managed document MIME set count is ${matches.length}, expected 1`,
    );
  }
  const bodyStart = matches[0].index + matches[0][0].lastIndexOf('[');
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '[',
    ']',
    `${filePath}: managed document MIME set`,
  );
  return { bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function findFunctionSegment(content, filePath, functionName, nextSignature) {
  const signature = `function ${functionName}(`;
  const start = content.indexOf(signature);
  if (start < 0 || content.indexOf(signature, start + signature.length) >= 0) {
    throw new Error(`${filePath}: ${functionName} function could not be identified exactly`);
  }
  if (nextSignature) {
    const end = content.indexOf(nextSignature, start + signature.length);
    if (end < 0 || content.indexOf(nextSignature, end + nextSignature.length) >= 0) {
      throw new Error(`${filePath}: ${functionName} boundary could not be identified exactly`);
    }
    return { start, end, body: content.slice(start, end) };
  }

  // This short helper can lose its neighbor during bundle tree-shaking.
  const parametersStart = start + signature.length - 1;
  const parametersEnd = findMatchingDelimiter(
    content,
    parametersStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  let bodyStart = parametersEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  const end = bodyEnd + 1;
  return { start, end, body: content.slice(start, end) };
}

function replaceRange(content, range, updatedBody) {
  return content.slice(0, range.bodyStart + 1) + updatedBody + content.slice(range.bodyEnd);
}

function replaceSegment(content, range, updatedBody) {
  return content.slice(0, range.start) + updatedBody + content.slice(range.end);
}

function matchState(content, filePath) {
  const documentSet = findDocumentMimeSet(content, filePath);
  const prepare = findFunctionSegment(
    content,
    filePath,
    'createManagedOutgoingMediaBlocks',
    'function sendStatus(',
  );
  const disposition = findFunctionSegment(
    content,
    filePath,
    'buildManagedMediaContentDisposition',
    'async function handleManagedOutgoingMediaHttpRequest(',
  );
  return {
    documentSet,
    prepare,
    disposition,
    originalDocument: [...documentSet.body.matchAll(ORIGINAL_DOCUMENT_MIME_PATTERN)],
    patchedDocument: [...documentSet.body.matchAll(PATCHED_DOCUMENT_MIME_PATTERN)],
    originalContentType: [...prepare.body.matchAll(ORIGINAL_CONTENT_TYPE_PATTERN)],
    patchedContentType: [...prepare.body.matchAll(PATCHED_CONTENT_TYPE_PATTERN)],
    originalKindGuard: [...prepare.body.matchAll(ORIGINAL_KIND_GUARD_PATTERN)],
    patchedKindGuard: [...prepare.body.matchAll(PATCHED_KIND_GUARD_PATTERN)],
    originalDisposition: [...disposition.body.matchAll(ORIGINAL_DISPOSITION_PATTERN)],
    patchedDisposition: [...disposition.body.matchAll(PATCHED_DISPOSITION_PATTERN)],
  };
}

function isExactPatchedState(state, markerCount, filePath) {
  if (
    state.patchedDocument.length !== 1 ||
    state.patchedContentType.length !== 1 ||
    state.patchedKindGuard.length !== 1 ||
    state.patchedDisposition.length !== 1 ||
    state.originalDocument.length > 0 ||
    state.originalContentType.length > 0 ||
    state.originalKindGuard.length > 0 ||
    state.originalDisposition.length > 0
  ) {
    return false;
  }
  const contentType = state.patchedContentType[0];
  const kindGuard = state.patchedKindGuard[0];
  if (
    contentType[2] !== kindGuard[3] ||
    contentType[4] !== kindGuard[6] ||
    contentType[5] !== kindGuard[5]
  ) {
    return false;
  }
  const markerInContentType = contentType[0].includes(`/*${MARKER}*/`);
  if (isGatewayBundlePath(filePath)) {
    return markerCount === 0 || (markerCount === 1 && markerInContentType);
  }
  return markerCount === 1 && markerInContentType;
}

function transform(content, filePath) {
  const markerCount = countOccurrences(content, MARKER);
  const state = matchState(content, filePath);
  if (isExactPatchedState(state, markerCount, filePath)) {
    return isGatewayBundlePath(filePath) && markerCount === 1
      ? content.replace(`/*${MARKER}*/`, '')
      : content;
  }

  const hasAnyPatchedShape =
    state.patchedDocument.length > 0 ||
    state.patchedContentType.length > 0 ||
    state.patchedKindGuard.length > 0 ||
    state.patchedDisposition.length > 0 ||
    markerCount > 0 ||
    content.includes('JUSTDO_TRUSTED_LOCAL_FILE_MEDIA');
  if (hasAnyPatchedShape) {
    throw new Error(
      `${filePath}: historical or partial trusted local file media patch detected ` +
        `(marker=${markerCount}, document=${state.originalDocument.length}/${state.patchedDocument.length}, ` +
        `contentType=${state.originalContentType.length}/${state.patchedContentType.length}, ` +
        `kindGuard=${state.originalKindGuard.length}/${state.patchedKindGuard.length}, ` +
        `disposition=${state.originalDisposition.length}/${state.patchedDisposition.length})`,
    );
  }
  if (
    state.originalDocument.length !== 1 ||
    state.originalContentType.length !== 1 ||
    state.originalKindGuard.length !== 1 ||
    state.originalDisposition.length !== 1
  ) {
    throw new Error(`${filePath}: trusted local file media pristine anchors are ambiguous`);
  }

  const originalContentType = state.originalContentType[0];
  const originalKindGuard = state.originalKindGuard[0];
  if (originalContentType[2] !== originalKindGuard[3] || originalContentType[4] === undefined) {
    throw new Error(`${filePath}: trusted local file media variables do not match`);
  }
  const contentTypeName = originalContentType[2];
  const itemName = originalContentType[4];
  const mediaKindName = originalKindGuard[2];
  const localPathName = (() => {
    const localPathPattern =
      /(?:^|[,;])\s*(?:(?:const|let)\s+)?([A-Za-z_$][\w$]*)\s*=\s*[^,;]*resolveLocalMediaPath\(/gu;
    const matches = [...state.prepare.body.matchAll(localPathPattern)];
    if (matches.length !== 1) {
      throw new Error(
        `${filePath}: local media path variable count is ${matches.length}, expected 1`,
      );
    }
    return matches[0][1];
  })();
  if (originalKindGuard[3] !== contentTypeName) {
    throw new Error(`${filePath}: managed media kind uses an unexpected content type variable`);
  }

  const documentMatch = state.originalDocument[0];
  const documentBody = state.documentSet.body.replace(
    ORIGINAL_DOCUMENT_MIME_PATTERN,
    `${documentMatch[1]}application/json${documentMatch[1]},${documentMatch[2]}` +
      `${documentMatch[3]}application/octet-stream${documentMatch[3]},${documentMatch[2]}` +
      `${documentMatch[3]}application/pdf${documentMatch[3]}`,
  );
  let updated = replaceRange(content, state.documentSet, documentBody);

  let updatedState = matchState(updated, filePath);
  const marker = isGatewayBundlePath(filePath) ? '' : `/*${MARKER}*/`;
  const contentTypeReplacement =
    `${originalContentType[1]} ?? (${localPathName} && ${itemName}.trustedLocal ? ` +
    `"application/octet-stream" : void 0);${marker}`;
  const prepareWithContentType = updatedState.prepare.body.replace(
    ORIGINAL_CONTENT_TYPE_PATTERN,
    contentTypeReplacement,
  );
  updated = replaceSegment(updated, updatedState.prepare, prepareWithContentType);

  updatedState = matchState(updated, filePath);
  const kindGuard = updatedState.originalKindGuard[0];
  const kindGuardReplacement =
    `${kindGuard[1]}if (!${mediaKindName} || (` +
    `normalizeMimeType(${contentTypeName}) === "application/octet-stream" && ` +
    `!(${localPathName} && ${itemName}.trustedLocal))) ` +
    `throw new Error("Managed media attachment has an unsupported content type");`;
  const prepareWithGuard = updatedState.prepare.body.replace(
    ORIGINAL_KIND_GUARD_PATTERN,
    kindGuardReplacement,
  );
  updated = replaceSegment(updated, updatedState.prepare, prepareWithGuard);

  updatedState = matchState(updated, filePath);
  const dispositionBody = updatedState.disposition.body.replace(
    ORIGINAL_DISPOSITION_PATTERN,
    'resolveManagedMediaKind($1)',
  );
  updated = replaceSegment(updated, updatedState.disposition, dispositionBody);

  const finalState = matchState(updated, filePath);
  const finalMarkerCount = countOccurrences(updated, MARKER);
  if (!isExactPatchedState(finalState, finalMarkerCount, filePath)) {
    throw new Error(`${filePath}: trusted local file media patch produced an invalid shape`);
  }
  return updated;
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(
      `trusted local file media target count is ${files.length}, expected ${expected}`,
    );
  }
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(
      `trusted local file media target count is ${files.length}, expected ${expected}`,
    );
  }
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: trusted local generic file delivery is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    MARKER,
    transform,
  },
};
