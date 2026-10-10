'use strict';

// Capability: observable recovery compaction and authoritative manual cancellation.
// Target: pristine openclaw@2026.9.8 native compaction, protocol and method policy.
// Scope: existing operator.admin/key custody, process-local bounded operation receipts.
// Safety: never retry an uncertain submission, evict cancellation IDs, cache transcripts,
//         or treat the absence of an active run as proof of preparation settlement.
// Remove when: upstream exposes operation-scoped cancellation/settlement covering
//             preparation and emits complete recovery compaction lifecycle events.

const {
  justDoCreateCompactionHandlers,
  justDoRunRecoveryCompaction,
} = require('./native-compaction-lifecycle.js');

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const {
  assertCurrentPatchContract,
  findMatchingDelimiter,
  isGatewayBundlePath,
  runtimeJavaScriptFiles,
  readRuntimeTextFile,
  writeIfChanged,
} = require('./_patch-utils.js');
const { canonicalHelper } = require('./034-plugin-owned-execution.cjs').__testing;
const CONTRACT = 'JUSTDO_NATIVE_COMPACTION_LIFECYCLE_V2026_9_8';
const factory = justDoCreateCompactionHandlers.toString();
const recoveryHelper = justDoRunRecoveryCompaction.toString();
const nativeName = 'justDoNativeCompactEmbeddedRunForRecovery';
const recoveryWrapper = `async function compactEmbeddedRunForRecovery(input, recovery) {
  return justDoRunRecoveryCompaction(${nativeName}, input, recovery);
}`;

function once(source, expression, replacement, label) {
  if ([...source.matchAll(new RegExp(expression.source, 'g'))].length !== 1)
    throw new Error(`${label}: compaction anchor changed`);
  return source.replace(expression, replacement);
}
function functionRange(source, name) {
  const match = source.match(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  if (!match || source.indexOf(`function ${name}(`, match.index + match[0].length) >= 0)
    throw new Error(`${name}: function topology changed`);
  const paren = source.indexOf('(', match.index);
  const close = findMatchingDelimiter(source, paren, '(', ')', name);
  const open = source.indexOf('{', close);
  const end = findMatchingDelimiter(source, open, '{', '}', name) + 1;
  return { start: match.index, end, text: source.slice(match.index, end) };
}
function canonicalCompiledHelper(body) {
  const ast = ts.createSourceFile(
    'helper.mjs',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const transformed = ts.transform(ast, [
    context => {
      const visit = node =>
        ts.isVariableDeclarationList(node)
          ? ts.factory.createVariableDeclarationList(
              node.declarations.map(declaration => ts.visitNode(declaration, visit)),
              ts.NodeFlags.Let,
            )
          : ts.visitEachChild(node, visit, context);
      return root => ts.visitNode(root, visit);
    },
  ]);
  try {
    // esbuild may merge const/let declarations while bundling. Normalize only
    // that emitted declaration kind; every initializer, write and effect still
    // participates in the complete, alpha-renamed semantic comparison.
    return canonicalHelper(
      ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]),
    );
  } finally {
    transformed.dispose();
  }
}
function assertHelper(source, name, expected, bundled = false) {
  const actual = functionRange(source, name).text;
  const canonical = bundled ? canonicalCompiledHelper : canonicalHelper;
  if (canonical(actual) !== canonical(expected))
    throw new Error(`${name}: historical or partial compaction helper`);
}
function editObject(source, anchor, edit) {
  const start = source.indexOf(anchor);
  if (start < 0 || source.indexOf(anchor, start + 1) >= 0)
    throw new Error(`${anchor}: schema topology changed`);
  const open = source.indexOf('{', start);
  const end = findMatchingDelimiter(source, open, '{', '}', anchor);
  return source.slice(0, open + 1) + edit(source.slice(open + 1, end)) + source.slice(end);
}
function appendFields(body, fields, label) {
  const first = fields.match(/^\s*([\w]+):/)[1];
  const position = body.indexOf(`${first}:`);
  if (position >= 0) {
    if (
      canonicalHelper(`function schema(){return {${body.slice(position)}};}`) !==
      canonicalHelper(`function schema(){return {${fields}};}`)
    )
      throw new Error(`${label}: partial compaction schema`);
    return body;
  }
  return body.replace(/,?\s*$/, ',') + fields;
}
function transformSchemas(source) {
  // The stock operation schema is an anonymous closedObject expression in
  // the npm package; the recovery bundle uses flattened TypeBox bindings.
  const event = source.match(
    /operationId:\s*NonEmptyString,\s*operation:\s*([\w$.]+)\("compact"\),/,
  );
  if (!event) throw new Error('Native compaction event schema changed');
  const eventOpen = source.lastIndexOf('{', event.index);
  const eventEnd = findMatchingDelimiter(source, eventOpen, '{', '}', 'operation schema');
  const body = source.slice(eventOpen + 1, eventEnd);
  const optional = body.match(/completed:\s*([\w$.]+)\(([\w$.]+)\(\)\)/);
  const integer = body.match(/ts:\s*([\w$.]+)\(\{ minimum: 0 \}\)/);
  const union = body.match(/phase:\s*([\w$.]+)\(\[/);
  const string = body.match(/reason:\s*[\w$.]+\(([\w$.]+)\(\)\)/);
  if (!optional || !integer || !union || !string)
    throw new Error('Native event field types changed');
  const [opt, bool] = optional.slice(1);
  const int = integer[1],
    literal = event[1],
    str = string[1];
  const fields = `outcome: ${opt}(${union[1]}([${['completed', 'skipped', 'failed', 'aborted'].map(value => `${literal}("${value}")`).join(',')} ])),
    ok: ${opt}(${bool}()), compacted: ${opt}(${bool}()), markerExpected: ${opt}(${bool}()),
    tokensBefore: ${opt}(${int}({minimum:0})), tokensAfter: ${opt}(${int}({minimum:0}))`;
  let result =
    source.slice(0, eventOpen + 1) +
    appendFields(body, fields, 'operation event') +
    source.slice(eventEnd);
  result = editObject(result, 'SessionsCompactParamsSchema =', compact => {
    const native = compact.match(/agentId:\s*([\w$.]+)\(NonEmptyString\)/);
    if (!native) throw new Error('Native compact schema changed');
    return appendFields(
      compact,
      `operationId: ${native[1]}(${str}({pattern:"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$",minLength:36,maxLength:36}))`,
      'compact params',
    );
  });
  return result;
}
function transformManual(source, bundled = false) {
  const native = source.includes('justDoNativeSessionCompactHandlers =');
  if (native) {
    assertHelper(source, 'justDoCreateCompactionHandlers', factory, bundled);
    const start = source.indexOf('justDoNativeSessionCompactHandlers =');
    const open = source.indexOf('{', start);
    const end = findMatchingDelimiter(source, open, '{', '}', 'manual custody');
    const body = source.slice(open, end + 1);
    if (
      !/signal\?\.throwIfAborted\(\)/.test(body) ||
      !/\boperationId\s*=\s*params.operationId\s*\?\?\s*randomUUID\d*\(\)/.test(body) ||
      body.includes('emitSessionOperation(context,')
    )
      throw new Error('Partial manual compaction custody');
    const calls = source.match(
      /sessionCompactHandlers = justDoCreateCompactionHandlers\(justDoNativeSessionCompactHandlers,\s*\{[^}]+\}\)/g,
    );
    const expected = `function bindings(){ return justDoCreateCompactionHandlers(justDoNativeSessionCompactHandlers,{randomUUID,assertValidParams,validateSessionsCompactParams,readGatewayRequestMutationAuthority,bindGatewayRequestHandlerMutationAuthority,emitSessionOperation,errorShape,ErrorCodes}); }`;
    const call = calls?.[0];
    const nativeRandom = body.match(
      /\boperationId\s*=\s*params.operationId\s*\?\?\s*(randomUUID\d*)\(\)/,
    )?.[1];
    const suppliedRandom =
      call?.match(/randomUUID:\s*(randomUUID\d*)\b/)?.[1] ??
      (call?.includes('randomUUID,') ? 'randomUUID' : undefined);
    let normalized = call;
    for (const name of [
      'randomUUID',
      'assertValidParams',
      'validateSessionsCompactParams',
      'readGatewayRequestMutationAuthority',
      'bindGatewayRequestHandlerMutationAuthority',
      'emitSessionOperation',
      'errorShape',
      'ErrorCodes',
    ])
      normalized = normalized?.replace(new RegExp(`\\b${name}\\d+\\b`, 'g'), name);
    if (
      calls?.length !== 1 ||
      suppliedRandom !== nativeRandom ||
      canonicalHelper(
        `function bindings(){ return ${normalized.slice(normalized.indexOf('=') + 1)}; }`,
      ) !== canonicalHelper(expected)
    )
      throw new Error('Partial manual compaction bindings');
    return source;
  }
  const declared = /const sessionCompactHandlers =/.test(source);
  let result = once(
    source,
    /(?:const )?sessionCompactHandlers = \{/,
    'const justDoNativeSessionCompactHandlers = {',
    'native compact handlers',
  );
  if (/import \{ a as readGatewayRequestMutationAuthority \} from /.test(result))
    result = once(
      result,
      /import \{ a as readGatewayRequestMutationAuthority \} from /,
      'import { a as readGatewayRequestMutationAuthority, n as bindGatewayRequestHandlerMutationAuthority } from ',
      'mutation custody import',
    );
  else if (!result.includes('function bindGatewayRequestHandlerMutationAuthority('))
    throw new Error('Native mutation authority binder missing');
  const start = result.indexOf('justDoNativeSessionCompactHandlers =');
  const open = result.indexOf('{', start);
  const end = findMatchingDelimiter(result, open, '{', '}', 'native compact handlers');
  let body = result.slice(open, end + 1);
  body = once(
    body,
    /const operationId = randomUUID\(\);/,
    'const operationId = params.operationId ?? randomUUID();',
    'operation identity',
  );
  body = once(
    body,
    /const assertRequestCurrent = \(\) => \{/,
    '$& signal?.throwIfAborted();',
    'preparation authority',
  );
  body = once(
    body,
    /emitSessionOperation\(context, \{\s*operationId,\s*operation: "compact",\s*phase: "start",\s*sessionKey: target.canonicalKey,\s*agentId: target.agentId\s*\}\);/,
    '',
    'native compact start',
  );
  body = once(
    body,
    /const emitCompactionEnd = \(completed, reason\) => emitSessionOperation\(context, \{\s*operationId,\s*operation: "compact",\s*phase: "end",\s*sessionKey: target.canonicalKey,\s*agentId: target.agentId,\s*completed,\s*reason\s*\}\);/,
    'const emitCompactionEnd = () => {};',
    'native compact end',
  );
  // Flattened recovery modules assign their declared bindings inside an init
  // closure. A fresh local declaration keeps the native initializer intact.
  result =
    result.slice(0, open) +
    body +
    `;\n${factory}\nconst sessionCompactHandlers = justDoCreateCompactionHandlers(justDoNativeSessionCompactHandlers,{randomUUID,assertValidParams,validateSessionsCompactParams,readGatewayRequestMutationAuthority,bindGatewayRequestHandlerMutationAuthority,emitSessionOperation,errorShape,ErrorCodes})` +
    result.slice(end + 1);
  if (!declared) {
    result = result.replace(
      'const sessionCompactHandlers = justDoCreateCompactionHandlers(',
      'sessionCompactHandlers = justDoCreateCompactionHandlers(',
    );
  }
  return result;
}
function prependExact(source, anchor, additions, label) {
  const matches = [...source.matchAll(new RegExp(anchor.source, 'g'))];
  if (matches.length !== 1) throw new Error(`${label}: native topology changed`);
  const position = matches[0].index;
  const prefix = source.slice(Math.max(0, position - 500), position);
  const candidate = [...prefix.matchAll(/\[\s*"sessions.compaction.status",/g)].at(-1)?.index;
  const actual =
    candidate === undefined
      ? undefined
      : prefix
          .slice(candidate)
          .match(
            /^\[\s*"sessions.compaction.status",[\s\S]+?\],\s*\[\s*"sessions.compaction.abort",[\s\S]+?\],\s*$/,
          )?.[0];
  if (actual) {
    if (
      canonicalHelper(`function fields(){return [${actual}];}`) !==
      canonicalHelper(`function fields(){return [${additions}];}`)
    )
      throw new Error(`${label}: partial compaction registry`);
    return source;
  }
  return source.slice(0, position) + additions + source.slice(position);
}
function transformRecovery(source, bundled = false) {
  if (source.includes(`function ${nativeName}(`)) {
    assertHelper(source, 'justDoRunRecoveryCompaction', recoveryHelper, bundled);
    assertHelper(source, 'compactEmbeddedRunForRecovery', recoveryWrapper, bundled);
    return source;
  }
  const original = functionRange(source, 'compactEmbeddedRunForRecovery');
  if (
    !/\.prepareRecoveryOwner\(\)/.test(original.text) ||
    !original.text.includes('compactContextEngineWithSafetyTimeout(') ||
    !/\.assertRecoveryActive\(\)/.test(original.text)
  )
    throw new Error('Native recovery custody changed');
  return (
    source.slice(0, original.start) +
    recoveryHelper +
    '\n' +
    recoveryWrapper +
    '\n' +
    original.text.replace('function compactEmbeddedRunForRecovery(', `function ${nativeName}(`) +
    source.slice(original.end)
  );
}
function transform(source, file = '<runtime>') {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  const hadMarker = source.includes(CONTRACT);
  const hadBehavior =
    source.includes('justDoNativeSessionCompactHandlers') ||
    source.includes(nativeName) ||
    source.includes('result.result.markerExpected') ||
    source.includes('sessions.compaction.status') ||
    source.includes('markerExpected: !!clientResult') ||
    source.includes('pattern:"^[a-fA-F0-9]{8}');
  if (hadBehavior && !hadMarker && !isGatewayBundlePath(file))
    throw new Error(`${file}: missing compaction contract marker`);
  let result = source;
  if (result.includes('SessionsCompactParamsSchema =')) result = transformSchemas(result);
  if (result.includes('sessionCompactHandlers ='))
    result = transformManual(result, isGatewayBundlePath(file));
  if (result.includes('function compactEmbeddedRunForRecovery('))
    result = transformRecovery(result, isGatewayBundlePath(file));
  if (result.includes('sessionTarget: resultSessionTarget')) {
    const field = 'markerExpected: !!clientResult && !memoryTranscript,';
    const existing = result.match(/markerExpected:([^,]+),\s*sessionTarget: resultSessionTarget,/);
    if (existing) {
      if (
        canonicalHelper(`function marker(){ return {markerExpected:${existing[1]}}; }`) !==
        canonicalHelper(`function marker(){ return {${field}}; }`)
      )
        throw new Error('Partial stock compaction marker provenance');
    } else
      result = once(
        result,
        /sessionTarget: resultSessionTarget,/,
        field + '$&',
        'stock compaction marker',
      );
  }
  if (/tokensBefore:\s*result\d*\.result\.tokensBefore/.test(result)) {
    result = result.replace(
      /(?:markerExpected:\s*(result\d*)\.result\.markerExpected === (?:true|!0),\s*)?tokensBefore:\s*(result\d*)\.result\.tokensBefore,/g,
      (matched, markerIdentity, resultIdentity) => {
        if (markerIdentity && markerIdentity !== resultIdentity)
          throw new Error('Compaction marker accounting identity changed');
        return markerIdentity
          ? matched
          : `markerExpected: ${resultIdentity}.result.markerExpected === true,` + matched;
      },
    );
  }
  const descriptor =
    /\[\s*"sessions.compact",\s*"sessions-compact",\s*"operator.admin",\s*"<=2026.7"\s*\]/;
  if (descriptor.test(result)) {
    const additions =
      '["sessions.compaction.status","sessions-compact","operator.admin","2026.9"],["sessions.compaction.abort","sessions-compact","operator.admin","2026.9"],';
    result = prependExact(result, descriptor, additions, 'method descriptors');
  }
  if (result.includes('SESSION_TARGET_POLICY_BY_METHOD =')) {
    const policy =
      /\[\s*"sessions.compact",\s*\{\s*fields: \["key"\],\s*required: (?:true|!0)\s*\}\]/;
    const additions =
      '["sessions.compaction.status",{fields:["key"],required:true,readOnly:true}],["sessions.compaction.abort",{fields:["key"],required:true}],';
    result = prependExact(result, policy, additions, 'session target policies');
  }
  if (hadMarker && result !== source)
    throw new Error(`${file}: historical or partial compaction patch`);
  if (result === source && !hadMarker && !hadBehavior)
    throw new Error(`${file}: missing compaction target`);
  return hadMarker || isGatewayBundlePath(file) ? result : `// ${CONTRACT}\n` + result;
}
const GROUPS = [
  ['function compactEmbeddedRunForRecovery(', 4],
  ['sessionCompactHandlers =', 2],
  ['SessionsCompactParamsSchema =', 2],
  ['SESSION_TARGET_POLICY_BY_METHOD =', 2],
  ['"sessions-compact",', 3],
  ['sessionTarget: resultSessionTarget', 2],
  ['tokensBefore: result.result.tokensBefore', 3],
];
function processTargets(root, verify) {
  const entries = runtimeJavaScriptFiles(root).flatMap(file => {
    const source = readRuntimeTextFile(file);
    return source.includes(CONTRACT) || GROUPS.some(([anchor]) => source.includes(anchor))
      ? [{ file, source }]
      : [];
  });
  const sources = entries.filter(entry => !isGatewayBundlePath(entry.file));
  if (
    sources.some(entry => entry.source.includes(CONTRACT)) &&
    sources.some(entry => !entry.source.includes(CONTRACT))
  )
    throw new Error('Mixed pristine and patched compaction capability; rebuild the locked runtime');
  for (const [anchor, count] of GROUPS) {
    const actual = sources.filter(entry => entry.source.includes(anchor)).length;
    if (actual !== count)
      throw new Error(`Compaction ${anchor}: source copies ${actual}, expected ${count}`);
  }
  if (fs.existsSync(path.join(root, 'gateway-bundle.mjs'))) {
    const bundle = entries.find(entry => isGatewayBundlePath(entry.file));
    if (
      !bundle ||
      GROUPS.some(([anchor]) =>
        anchor.startsWith('tokensBefore:')
          ? !/tokensBefore:\s*result\d*\.result\.tokensBefore/.test(bundle.source)
          : !bundle.source.includes(anchor),
      )
    )
      throw new Error('Incomplete compaction capability in the Gateway bundle');
  }
  // Plan every source and bundle transformation before committing any bytes.
  const plans = entries.map(entry => ({ ...entry, next: transform(entry.source, entry.file) }));
  if (verify) {
    if (plans.some(entry => entry.source !== entry.next))
      throw new Error('Native compaction capability is not applied');
    return [];
  }
  return plans.flatMap(entry =>
    writeIfChanged(entry.file, entry.source, entry.next) ? [entry.file] : [],
  );
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: {
    transform,
    justDoCreateCompactionHandlers,
    justDoRunRecoveryCompaction,
    CONTRACT,
    GROUPS,
  },
};
