'use strict';

// Capability: let the trusted JustDo host choose the managed key and atomically
// include a selected assistant response in a message fork.
// Target: openclaw@2026.9.8 sessions.fork schema, Gateway handler, and SQLite cut resolver.
// Scope: operator.admin callers and agent-scoped `justdo` session keys only.
// Safety: default dashboard keys remain unchanged and an existing target is never overwritten.
// Remove when: upstream sessions.fork supports a collision-safe, host-selected target key.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKERS = {
  schema: 'JUSTDO_MANAGED_SESSION_FORK_TARGET_KEY_SCHEMA_V2026_9_8',
  handler: 'JUSTDO_MANAGED_SESSION_FORK_TARGET_KEY_HANDLER_V2026_9_8',
  accessor: 'JUSTDO_MANAGED_SESSION_FORK_ASSISTANT_ENTRY_V2026_9_8',
};
const PATCH_MARKER_PATTERN =
  /JUSTDO_MANAGED_SESSION_FORK_(?:TARGET_KEY_(?:SCHEMA|HANDLER)|ASSISTANT_ENTRY)_V\d+_\d+_\d+/gu;

function expectedSchemaCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function expectedAccessorCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 5 : 4;
}

function schemaTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'SessionsForkParamsSchema',
    'SessionsRewindParamsSchema.properties',
  ]);
}
// Worker deployments expose worker RPC clients, not Gateway server-method handlers.
// Their native SQLite accessor and schema copies are patched separately below.
function handlerTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'async function mutateSessionAtMessage(',
    'buildDashboardSessionKey',
    'forkSessionAtMessage',
    'resolveOperatorSessionCreation',
  ]).filter(filePath => !filePath.includes(`${path.sep}dist${path.sep}worker${path.sep}`));
}

function accessorTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function resolveMessageCut(',
    'mutateSqliteSessionAtMessageInTransaction',
    'selectSessionTranscriptTreePathNodes',
  ]);
}

function assertTargetCount(files, expected, label) {
  if (files.length !== expected) {
    throw new Error(`${label} target count is ${files.length}, expected ${expected}`);
  }
}

function findNamedFunctionRange(content, functionName, filePath) {
  const signature = `async function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  }
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return { bodyStart, bodyEnd, body: content.slice(bodyStart + 1, bodyEnd) };
}

function transformSchema(content, filePath) {
  if (
    [...content.matchAll(PATCH_MARKER_PATTERN)].some(
      match => !Object.values(MARKERS).includes(match[0]),
    )
  )
    throw new Error(filePath + ': historical managed fork patch');
  const declaration = /SessionsForkParamsSchema\s*=\s*([\w$]+)\(/.exec(content);
  if (!declaration) throw new Error(filePath + ': fork schema anchor missing');
  const start = declaration.index + declaration[0].length;
  const end = findMatchingDelimiter(content, start - 1, '(', ')', filePath);
  const body = content.slice(start, end);
  const optional = /editorText:\s*([\w$.]+)\(/.exec(content)?.[1];
  if (!optional) throw new Error(filePath + ': fork optional schema builder missing');
  const expected =
    '{...SessionsRewindParamsSchema.properties, targetKey: ' +
    optional +
    '(NonEmptyString), includeEntry: ' +
    optional +
    '({"~kind": "Boolean", type: "boolean"})}';
  const normalize = value => value.replace(/\/\*[^]*?\*\//g, '').replace(/\s+/g, '');
  if (normalize(body) === normalize(expected)) {
    if (!isGatewayBundlePath(filePath) && !body.includes(MARKERS.schema))
      throw new Error('Partial fork schema marker');
    return content;
  }
  if (body.trim() !== 'SessionsRewindParamsSchema.properties')
    throw new Error(filePath + ': historical or partial managed fork schema');
  return content.slice(0, start) + '/*' + MARKERS.schema + '*/' + expected + content.slice(end);
}

function transformHandler(content, filePath) {
  const range = findNamedFunctionRange(content, 'mutateSessionAtMessage', filePath);
  const markerCount = countOccurrences(range.body, MARKERS.handler);
  const historicalMarkers = [...range.body.matchAll(PATCH_MARKER_PATTERN)].filter(
    match => match[0] !== MARKERS.handler,
  ).length;
  const hasManagedLifecycleIdentity = /\.\.\.\s*(?:\(\s*)?requestedForkTargetKey\s*\?/u.test(
    range.body,
  );
  const alreadyPatched =
    range.body.includes('requestedForkTargetKey') &&
    range.body.includes('requestedForkIncludeEntry') &&
    range.body.includes('sessions.fork includeEntry requires targetKey') &&
    range.body.includes('sessions.fork includeEntry is unavailable for linked sessions') &&
    range.body.includes('sessions.fork targetKey requires operator.admin') &&
    range.body.includes('sessions.fork targetKey must use the managed JustDo namespace') &&
    range.body.includes('sessions.fork targetKey already exists') &&
    hasManagedLifecycleIdentity;
  if (alreadyPatched && historicalMarkers === 0) {
    if (
      (isGatewayBundlePath(filePath) && markerCount === 0) ||
      (!isGatewayBundlePath(filePath) && markerCount === 1)
    ) {
      return content;
    }
    throw new Error(`${filePath}: historical or partial managed fork targetKey handler detected`);
  }
  if (
    markerCount > 0 ||
    historicalMarkers > 0 ||
    range.body.includes('requestedForkTargetKey') ||
    range.body.includes('requestedForkIncludeEntry')
  ) {
    throw new Error(`${filePath}: historical or partial managed fork targetKey handler detected`);
  }

  const cfgPattern = /(const cfg\s*=\s*context\.getRuntimeConfig\(\)\s*;)/u;
  if ([...range.body.matchAll(new RegExp(cfgPattern.source, 'gu'))].length !== 1) {
    throw new Error(`${filePath}: sessions.fork runtime config target is missing or ambiguous`);
  }
  const marker = isGatewayBundlePath(filePath) ? '' : `/*${MARKERS.handler}*/`;
  const admission = [
    '$1',
    '\tconst requestedForkTargetKey = action === "fork" && typeof params.targetKey === "string" ? params.targetKey.trim() : "";',
    '\tconst requestedForkIncludeEntry = action === "fork" && params.includeEntry === true;',
    '\tif (requestedForkIncludeEntry && !requestedForkTargetKey) {',
    '\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.fork includeEntry requires targetKey"));',
    '\t\treturn;',
    '\t}',
    '\tif (requestedForkTargetKey && client !== null && !client?.connect?.scopes?.includes("operator.admin")) {',
    '\t\trespond(false, void 0, errorShape(ErrorCodes.FORBIDDEN, "sessions.fork targetKey requires operator.admin"));',
    '\t\treturn;',
    `\t}${marker}`,
  ].join('\n');
  let patchedBody = range.body.replace(cfgPattern, admission);

  const lifecyclePattern = /(const lifecycleIdentities\s*=\s*\[)([\s\S]*?)(\]\s*;)/u;
  const lifecycleMatches = [...patchedBody.matchAll(new RegExp(lifecyclePattern.source, 'gu'))];
  if (lifecycleMatches.length !== 1) {
    throw new Error(
      `${filePath}: sessions.fork lifecycle identity count is ${lifecycleMatches.length}, expected 1`,
    );
  }
  patchedBody = patchedBody.replace(lifecyclePattern, (_match, start, items, end) => {
    const normalizedItems = items.trimEnd();
    const separator = normalizedItems.endsWith(',') ? '' : ',';
    return `${start}${normalizedItems}${separator}\n\t\t...(requestedForkTargetKey ? [requestedForkTargetKey] : []),\n\t${end}`;
  });

  const targetPattern =
    /const targetKey\s*=\s*action\s*===\s*"fork"\s*\?\s*buildDashboardSessionKey\(current\.target\.agentId,\s*\{\s*incognito:\s*current\.entry\.incognito\s*===\s*true\s*\|\|\s*isIncognitoSessionKey\(current\.canonicalKey\)\s*\}\)\s*:\s*current\.canonicalKey\s*;/u;
  const targetMatches = [...patchedBody.matchAll(new RegExp(targetPattern.source, 'gu'))];
  if (targetMatches.length !== 1) {
    throw new Error(
      `${filePath}: sessions.fork target key selection count is ${targetMatches.length}, expected 1`,
    );
  }
  const selection = [
    'if (requestedForkTargetKey) {',
    '\t\t\tconst managedPrefix = `agent:${current.target.agentId}:justdo:`;',
    '\t\t\tif (!requestedForkTargetKey.startsWith(managedPrefix)) {',
    '\t\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.fork targetKey must use the managed JustDo namespace"));',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '\t\t\tconst existingTarget = loadAccessorSessionEntryForGatewayTarget({ key: requestedForkTargetKey, cfg, agentId: current.target.agentId });',
    '\t\t\tif (existingTarget.entry) {',
    '\t\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.fork targetKey already exists"));',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '\t\t}',
    '\t\tconst targetKey = action === "fork" ? requestedForkTargetKey || buildDashboardSessionKey(current.target.agentId, { incognito: current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey) }) : current.canonicalKey;',
  ].join('\n');
  patchedBody = patchedBody.replace(targetPattern, selection);

  const upstreamPattern = /(const upstreamLink\s*=\s*readSessionUpstreamLink\([^;]+;)/u;
  const upstreamMatches = [...patchedBody.matchAll(new RegExp(upstreamPattern.source, 'gu'))];
  if (upstreamMatches.length !== 1) {
    throw new Error(
      `${filePath}: sessions.fork includeEntry upstream guard count is ${upstreamMatches.length}, expected 1`,
    );
  }
  patchedBody = patchedBody.replace(
    upstreamPattern,
    [
      '$1',
      '\t\tif (requestedForkIncludeEntry && upstreamLink) {',
      '\t\t\trespond(false, void 0, errorShape(ErrorCodes.INVALID_REQUEST, "sessions.fork includeEntry is unavailable for linked sessions"));',
      '\t\t\treturn;',
      '\t\t}',
    ].join('\n'),
  );

  const forkCallPattern =
    /(forkSessionAtMessage\(\s*\{\s*\.\.\.mutationParams,\s*entryId,\s*targetKey(?:\s*:\s*[\w$]+)?,)(\s*repositoryWorkspaceId\s*:)/u;
  const forkCallMatches = [...patchedBody.matchAll(new RegExp(forkCallPattern.source, 'gu'))];
  if (forkCallMatches.length !== 1) {
    throw new Error(
      `${filePath}: sessions.fork includeEntry forwarding count is ${forkCallMatches.length}, expected 1`,
    );
  }
  patchedBody = patchedBody.replace(
    forkCallPattern,
    '$1\n\t\t\t\tincludeEntry: requestedForkIncludeEntry,$2',
  );
  return `${content.slice(0, range.bodyStart + 1)}${patchedBody}${content.slice(range.bodyEnd)}`;
}

function findSyncFunctionRange(content, functionName, filePath) {
  const signature = `function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  }
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return {
    signatureIndex,
    parameterStart,
    parameterEnd,
    bodyStart,
    bodyEnd,
    body: content.slice(bodyStart + 1, bodyEnd),
  };
}

function transformAccessor(content, filePath) {
  if (filePath.includes(path.sep + 'worker' + path.sep))
    return transformWorkerAccessor(content, filePath);
  const markerCount = countOccurrences(content, MARKERS.accessor);
  const historicalMarkers = [...content.matchAll(PATCH_MARKER_PATTERN)].filter(
    match => !Object.values(MARKERS).includes(match[0]),
  ).length;
  const alreadyPatched =
    content.includes('includeEntry: params.includeEntry') &&
    content.includes('params.mode === "fork" && params.includeEntry === true') &&
    content.includes('includeTargetEntry') &&
    content.includes('targetIndex + (includeTargetEntry ? 1 : 0)') &&
    content.includes('stopReason == null || ["stop", "length"].includes') &&
    /includeTargetEntry\s*\?\s*(?:undefined|void\s+0)\s*:\s*\(?readMessageWorkContext/u.test(
      content,
    ) &&
    content.includes('parentId: includeTargetEntry ?');
  if (alreadyPatched && historicalMarkers === 0) {
    if (
      (isGatewayBundlePath(filePath) && markerCount === 0) ||
      (!isGatewayBundlePath(filePath) && markerCount === 1)
    ) {
      return content;
    }
    throw new Error(`${filePath}: historical or partial assistant-entry fork accessor detected`);
  }
  if (markerCount > 0 || content.includes('includeTargetEntry')) {
    throw new Error(`${filePath}: historical or partial assistant-entry fork accessor detected`);
  }

  const callPattern = /resolveMessageCut\(events,\s*params\.entryId\)/u;
  const callMatches = [...content.matchAll(new RegExp(callPattern.source, 'gu'))];
  if (callMatches.length !== 1) {
    throw new Error(
      `${filePath}: resolveMessageCut call count is ${callMatches.length}, expected 1`,
    );
  }
  let patched = content.replace(
    callPattern,
    'resolveMessageCut(events, params.entryId, params.mode === "fork" && params.includeEntry === true)',
  );

  const transactionPattern =
    /(mutateSqliteSessionAtMessageInTransaction\([^,]+,\s*resolved,\s*\{\s*entryId:\s*params\.entryId,)/u;
  const transactionMatches = [...patched.matchAll(new RegExp(transactionPattern.source, 'gu'))];
  if (transactionMatches.length !== 1) {
    throw new Error(
      `${filePath}: assistant-entry fork transaction forwarding count is ${transactionMatches.length}, expected 1`,
    );
  }
  patched = patched.replace(transactionPattern, '$1\n\t\tincludeEntry: params.includeEntry,');

  const range = findSyncFunctionRange(patched, 'resolveMessageCut', filePath);
  const parameters = patched.slice(range.parameterStart + 1, range.parameterEnd);
  if (!/^\s*events\s*,\s*entryId\s*$/u.test(parameters)) {
    throw new Error(`${filePath}: resolveMessageCut parameters are unexpected`);
  }
  let body = range.body;
  const rolePattern =
    /if\s*\(\s*([\w$]+)\?\.type\s*!==\s*"message"\s*\|\|\s*([\w$]+)\?\.role\s*!==\s*"user"\s*\)\s*(?:\{\s*return\s*\{\s*status:\s*"not-user-message"\s*\}\s*;?\s*\}|return\s*\{\s*status:\s*"not-user-message"\s*\}\s*;?)/u;
  const roleMatches = [...body.matchAll(new RegExp(rolePattern.source, 'gu'))];
  if (roleMatches.length !== 1) {
    throw new Error(`${filePath}: resolveMessageCut role guard is missing or ambiguous`);
  }
  const [, recordName, messageName] = roleMatches[0];
  const targetDeclarationPattern = new RegExp(
    `const\\s+${recordName}\\s*=\\s*asOptionalRecord\\(([\\w$]+)\\.entry\\);`,
    'u',
  );
  const targetDeclaration = body.match(targetDeclarationPattern);
  if (!targetDeclaration) {
    throw new Error(`${filePath}: resolveMessageCut target identity is missing`);
  }
  const targetName = targetDeclaration[1];
  const marker = isGatewayBundlePath(filePath) ? '' : `/*${MARKERS.accessor}*/`;
  body = body.replace(
    rolePattern,
    `const includeTargetEntry = includeEntry && ${messageName}?.role === "assistant" && (${messageName}.stopReason == null || ["stop", "length"].includes(${messageName}.stopReason));${marker}\n\tif (${recordName}?.type !== "message" || (${messageName}?.role !== "user" && !includeTargetEntry)) return { status: "not-user-message" };`,
  );
  const slicePattern = /activePath\.slice\(0,\s*targetIndex\)/u;
  if ([...body.matchAll(new RegExp(slicePattern.source, 'gu'))].length !== 1) {
    throw new Error(`${filePath}: resolveMessageCut prefix slice is missing or ambiguous`);
  }
  body = body.replace(
    slicePattern,
    'activePath.slice(0, targetIndex + (includeTargetEntry ? 1 : 0))',
  );

  const editorPattern =
    /const editorAttachments\s*=\s*extractEditorAttachments\(([\w$]+)\.content\);\s*const editorMediaRefs\s*=\s*extractEditorMediaRefs\(\1\);/u;
  const editorMatches = [...body.matchAll(new RegExp(editorPattern.source, 'gu'))];
  if (editorMatches.length !== 1) {
    throw new Error(`${filePath}: resolveMessageCut editor payload is missing or ambiguous`);
  }
  const editorMessageName = editorMatches[0][1];
  body = body.replace(
    editorPattern,
    [
      `const editorText = includeTargetEntry ? undefined : (readMessageWorkContext(${editorMessageName})?.text ?? extractEditorText(${editorMessageName}.content));`,
      `\tconst editorAttachments = includeTargetEntry ? undefined : extractEditorAttachments(${editorMessageName}.content);`,
      `\tconst editorMediaRefs = includeTargetEntry ? undefined : extractEditorMediaRefs(${editorMessageName});`,
    ].join('\n'),
  );
  const editorTextPattern =
    /editorText:\s*readMessageWorkContext\([^)]*\)\?\.text\s*\?\?\s*extractEditorText\([\w$]+\.content\),/u;
  if ([...body.matchAll(new RegExp(editorTextPattern.source, 'gu'))].length !== 1) {
    throw new Error(`${filePath}: resolveMessageCut editor text result is missing or ambiguous`);
  }
  body = body.replace(editorTextPattern, '...editorText ? { editorText } : {},');
  const parentPattern = new RegExp(`parentId:\\s*${targetName}\\.parentId`, 'u');
  const parentMatches = [...body.matchAll(new RegExp(parentPattern.source, 'gu'))];
  if (parentMatches.length !== 1) {
    throw new Error(`${filePath}: resolveMessageCut parent result is missing or ambiguous`);
  }
  body = body.replace(
    parentPattern,
    `parentId: includeTargetEntry ? ${targetName}.id : ${targetName}.parentId`,
  );
  return `${patched.slice(0, range.parameterStart + 1)}events, entryId, includeEntry = false${patched.slice(range.parameterEnd, range.bodyStart + 1)}${body}${patched.slice(range.bodyEnd)}`;
}

function transformWorkerAccessor(content, filePath) {
  if (content.includes(MARKERS.accessor)) {
    if (
      !content.includes('justDoIncludeForkEntry') ||
      !/includeEntry:[\w$]+\.includeEntry/.test(content)
    )
      throw new Error('Partial worker fork accessor');
    return content;
  }
  if (
    [...content.matchAll(PATCH_MARKER_PATTERN)].some(
      match => !Object.values(MARKERS).includes(match[0]),
    ) ||
    content.includes('justDoIncludeForkEntry')
  )
    throw new Error('Historical worker fork accessor');
  let range = findSyncFunctionRange(content, 'resolveMessageCut', filePath);
  let body = range.body;
  const role =
    /if\((\w+)\?\.type!==`message`\|\|(\w+)\?\.role!==`user`\)return\{status:`not-user-message`\}/.exec(
      body,
    );
  const slice = /([\w$]+)\.slice\(0,([\w$]+)\)/.exec(body);
  const parent = /parentId:([\w$]+)\.parentId,prefix:/.exec(body);
  if (!role || !slice || !parent) throw new Error(filePath + ': native worker message cut changed');
  const message = role[2];
  body = body.replace(
    role[0],
    'const justDoIncludeForkEntry = includeEntry && ' +
      message +
      '?.role === "assistant" && (' +
      message +
      '.stopReason == null || ["stop", "length"].includes(' +
      message +
      '.stopReason));/*' +
      MARKERS.accessor +
      '*/if(' +
      role[1] +
      '?.type !== "message" || (' +
      message +
      '?.role !== "user" && !justDoIncludeForkEntry)) return {status:"not-user-message"};',
  );
  body = body.replace(
    slice[0],
    slice[1] + '.slice(0,' + slice[2] + ' + (justDoIncludeForkEntry ? 1 : 0))',
  );
  body = body.replace(
    'parentId:' + parent[1] + '.parentId,prefix:',
    'parentId:justDoIncludeForkEntry ? ' + parent[1] + '.id : ' + parent[1] + '.parentId,prefix:',
  );
  body = body.replace(
    /editorText:readMessageWorkContext\(([^)]+)\)\?\.text\?\?extractEditorText\(([^)]+)\),/,
    'editorText:justDoIncludeForkEntry ? undefined : readMessageWorkContext($1)?.text??extractEditorText($2),',
  );
  body = body
    .replace(
      /extractEditorAttachments\(([^)]+)\)/,
      '(justDoIncludeForkEntry ? undefined : extractEditorAttachments($1))',
    )
    .replace(
      /extractEditorMediaRefs\(([^)]+)\)/,
      '(justDoIncludeForkEntry ? undefined : extractEditorMediaRefs($1))',
    );
  let patched =
    content.slice(0, range.parameterEnd) +
    ',includeEntry=false' +
    content.slice(range.parameterEnd, range.bodyStart + 1) +
    body +
    content.slice(range.bodyEnd);
  patched = patched.replace(
    /resolveMessageCut\(([\w$]+),([\w$]+)\.entryId\)/,
    'resolveMessageCut($1,$2.entryId,$2.mode === "fork" && $2.includeEntry === true)',
  );
  patched = patched.replace(
    /(mutateSqliteSessionAtMessageInTransaction\([^,]+,[^,]+,\{entryId:([\w$]+)\.entryId,)/,
    '$1includeEntry:$2.includeEntry,',
  );
  if (!/includeEntry:[\w$]+\.includeEntry/.test(patched))
    throw new Error('Worker fork transaction forwarding missing');
  return patched;
}

function applyPatch(runtimeDir) {
  const schemas = schemaTargets(runtimeDir);
  const handlers = handlerTargets(runtimeDir);
  const accessors = accessorTargets(runtimeDir);
  assertTargetCount(
    schemas,
    fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 5 : 4,
    'managed fork targetKey schema',
  );
  assertTargetCount(handlers, expectedSchemaCount(runtimeDir), 'managed fork targetKey handler');
  assertTargetCount(accessors, expectedAccessorCount(runtimeDir), 'assistant-entry fork accessor');
  const changed = [];
  for (const [files, transform] of [
    [schemas, transformSchema],
    [handlers, transformHandler],
    [accessors, transformAccessor],
  ]) {
    for (const filePath of files) {
      const original = fs.readFileSync(filePath, 'utf8');
      const updated = transform(original, filePath);
      if (writeIfChanged(filePath, original, updated))
        changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const schemas = schemaTargets(runtimeDir);
  const handlers = handlerTargets(runtimeDir);
  const accessors = accessorTargets(runtimeDir);
  assertTargetCount(
    schemas,
    fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 5 : 4,
    'managed fork targetKey schema',
  );
  assertTargetCount(handlers, expectedSchemaCount(runtimeDir), 'managed fork targetKey handler');
  assertTargetCount(accessors, expectedAccessorCount(runtimeDir), 'assistant-entry fork accessor');
  for (const filePath of schemas) {
    if (
      transformSchema(fs.readFileSync(filePath, 'utf8'), filePath) !==
      fs.readFileSync(filePath, 'utf8')
    ) {
      throw new Error(`${filePath}: managed fork targetKey schema is missing`);
    }
  }
  for (const filePath of handlers) {
    if (
      transformHandler(fs.readFileSync(filePath, 'utf8'), filePath) !==
      fs.readFileSync(filePath, 'utf8')
    ) {
      throw new Error(`${filePath}: managed fork targetKey handler is missing`);
    }
  }
  for (const filePath of accessors) {
    if (
      transformAccessor(fs.readFileSync(filePath, 'utf8'), filePath) !==
      fs.readFileSync(filePath, 'utf8')
    ) {
      throw new Error(`${filePath}: assistant-entry fork accessor is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    MARKERS,
    transformAccessor,
    transformWorkerAccessor,
    transformHandler,
    transformSchema,
  },
};
