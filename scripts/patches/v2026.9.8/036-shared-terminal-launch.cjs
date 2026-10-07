'use strict';

// Capability: share the desktop terminal with the chat agent in its project directory.
// Target: pristine openclaw@2026.9.8 terminal schemas, RPC launch and PTY close.
// Scope: operator.admin terminal.open launch overrides and explicit terminal.close termination.
// Safety: retain native sandbox admission, exact chat incarnation, viewer checks and tool approvals.
// Remove when: native terminal.open accepts cwd/shell/args and terminal.close can terminate a shared PTY.
const fs = require('node:fs');
const path = require('node:path');
const { transformSync } = require('esbuild');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');
const CONTRACT = 'JUSTDO_SHARED_TERMINAL_LAUNCH_V2026_9_8';
const canonical = text =>
  transformSync(text, { loader: 'js', minifySyntax: true, legalComments: 'none' }).code;

function replaceOnce(text, expression, replacement, label) {
  if ([...text.matchAll(new RegExp(expression.source, 'g'))].length !== 1) {
    throw new Error(`${label}: native terminal anchor changed`);
  }
  return text.replace(expression, replacement);
}
function schema(content, name, edit) {
  const start = content.indexOf(`${name} =`);
  if (start < 0) return content;
  if (content.indexOf(`${name} =`, start + 1) >= 0) throw new Error(`${name}: topology changed`);
  const open = content.indexOf('{', start);
  const end = findMatchingDelimiter(content, open, '{', '}', name);
  return content.slice(0, open + 1) + edit(content.slice(open + 1, end)) + content.slice(end);
}
function handler(content, name, edit) {
  const signature = `"${name}": async (opts) => {`;
  const start = content.indexOf(signature);
  if (start < 0 || content.indexOf(signature, start + 1) >= 0)
    throw new Error(`${name}: handler topology changed`);
  const open = start + signature.length - 1;
  const end = findMatchingDelimiter(content, open, '{', '}', name);
  return content.slice(0, open + 1) + edit(content.slice(open + 1, end)) + content.slice(end);
}
function transform(content, file = '<runtime>') {
  assertCurrentPatchContract(content, CONTRACT, file, false);
  const hadMarker = content.includes(CONTRACT);
  const hadBehavior =
    content.includes('justDoTerminal') ||
    /TerminalOpenParamsSchema\s*=\s*[\w$]+\(\{\s*cwd:/.test(content);
  let result = content;
  let schemaType;
  let schemaString;
  if (content.includes('TerminalOpenParamsSchema =')) {
    result = schema(result, 'TerminalOpenParamsSchema', body => {
      const type = body.match(/agentId:\s*([\w$]+)\.Optional\(([\w$]+)\)/);
      const embedded =
        /agentId:\s*Optional\$2\(NonEmptyString\)/.test(body) &&
        [
          'function _Array_(items, options)',
          'function String$2(options)',
          'function Boolean$1(options)',
        ].every(fragment => content.includes(fragment));
      if (!type && !embedded) throw new Error(`${file}: terminal open schema changed`);
      schemaType = type
        ? {
            optional: `${type[1]}.Optional`,
            array: `${type[1]}.Array`,
            string: `${type[1]}.String`,
            boolean: `${type[1]}.Boolean`,
          }
        : { optional: 'Optional$2', array: '_Array_', string: 'String$2', boolean: 'Boolean$1' };
      schemaString = type?.[2] ?? 'NonEmptyString';
      const fields = `cwd: ${schemaType.optional}(${schemaString}), shell: ${schemaType.optional}(${schemaString}), args: ${schemaType.optional}(${schemaType.array}(${schemaType.string}(), { maxItems: 32 })),`;
      if (/\bcwd:/.test(body)) {
        const beforeAgent = body.slice(0, body.indexOf('agentId:'));
        if (canonical(`({${beforeAgent}})`) !== canonical(`({${fields}})`))
          throw new Error(`${file}: partial terminal schema`);
        return body;
      }
      return fields + body;
    });
    result = schema(result, 'TerminalCloseParamsSchema', body => {
      const type = schemaType;
      if (!type) throw new Error(`${file}: terminal schema type missing`);
      if (/\bterminate:/.test(body)) {
        if (
          canonical(`({${body}})`) !==
          canonical(
            `({sessionId: ${schemaString}, terminate: ${type.optional}(${type.boolean}())})`,
          )
        )
          throw new Error(`${file}: partial terminal close schema`);
        return body;
      }
      return body + `, terminate: ${type.optional}(${type.boolean}())`;
    });
  }
  if (
    content.includes('const spawnPlan = resolveTerminalOpenSpawnPlan(') ||
    content.includes('justDoTerminalLaunch =')
  ) {
    const native =
      /const spawnPlan = resolveTerminalOpenSpawnPlan\(refreshedLaunch\.plan, catalogPlan\);/;
    const patched = `const justDoTerminalLaunch = !catalogPlan ? request : {};
const spawnPlan = { ...resolveTerminalOpenSpawnPlan(refreshedLaunch.plan, catalogPlan),
  ...(justDoTerminalLaunch.cwd ? { cwd: justDoTerminalLaunch.cwd } : {}),
  ...(justDoTerminalLaunch.shell ? { shell: justDoTerminalLaunch.shell, args: justDoTerminalLaunch.args ?? [] } : {}) };`;
    if (result.includes('justDoTerminalLaunch =')) {
      const start = result.indexOf('justDoTerminalLaunch =');
      const plan = result.indexOf('spawnPlan =', start);
      const open = result.indexOf('{', plan);
      const end = findMatchingDelimiter(result, open, '{', '}', 'terminal spawn plan') + 1;
      const requestBinding = result
        .slice(start, plan)
        .match(
          /^justDoTerminalLaunch = (?:!catalogPlan \? (request\d*) : \{\}|catalogPlan \? \{\} : (request\d*)\b)/,
        );
      const compiledRequest = isGatewayBundlePath(file)
        ? (requestBinding?.[1] ?? requestBinding?.[2])
        : 'request';
      if (
        plan < 0 ||
        !compiledRequest ||
        canonical(`const ${result.slice(start, end)};`) !==
          canonical(patched.replace('? request :', `? ${compiledRequest} :`))
      )
        throw new Error(`${file}: partial terminal launch`);
    } else result = replaceOnce(result, native, patched, file);
    result = handler(result, 'terminal.open', body => {
      const cols = /cols:\s*params\.cols,/;
      const fields = 'cwd: params.cwd, shell: params.shell, args: params.args, ';
      if (body.includes('cwd: params.cwd')) {
        if (
          !/cwd:\s*params\.cwd,\s*shell:\s*params\.shell,\s*args:\s*params\.args,\s*cols:\s*params\.cols,/.test(
            body,
          )
        )
          throw new Error(`${file}: partial terminal RPC`);
        return body;
      } else return replaceOnce(body, cols, fields + '$&', file);
    });
    result = handler(result, 'terminal.close', body => {
      const close = /\.close\(connId, params\.sessionId\)\s*\?\?\s*false/;
      if (!/params\.terminate === (?:true|!0)/.test(body)) {
        return replaceOnce(
          body,
          close,
          '.close(connId, params.sessionId, params.terminate === true) ?? false',
          file,
        );
      } else if (
        !/\.close\(connId, params\.sessionId, params\.terminate === (?:true|!0)\)\s*\?\?\s*(?:false|!1)/.test(
          body,
        )
      )
        throw new Error(`${file}: partial terminal close RPC`);
      return body;
    });
  }
  if (
    content.includes('close(connId, sessionId) {') ||
    content.includes('justDoTerminalTerminate')
  ) {
    const native = `close(connId, sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) return false;
      if (session.owner?.kind === "agent") {
        if (!session.viewers.has(connId)) return false;
        if (session.unadoptedViewerConnId === connId) {
          this.finalize(session, "closed", {}); return true;
        }
        return this.removeViewer(session, connId);
      }
      if (session.owner?.kind !== "conn" || session.owner.connId !== connId || session.closed) return false;
      this.finalize(session, "closed", {}); return true;
    }`;
    const patched = native
      .replace(
        'close(connId, sessionId)',
        'close(connId, sessionId, justDoTerminalTerminate = false)',
      )
      .replace(
        'session.unadoptedViewerConnId === connId',
        'justDoTerminalTerminate === true || session.unadoptedViewerConnId === connId',
      );
    const start = result.search(/close\(connId, sessionId[^)]*\)\s*\{/);
    if (start < 0) throw new Error(`${file}: terminal close method missing`);
    const open = result.indexOf('{', start);
    const end = findMatchingDelimiter(result, open, '{', '}', 'terminal close');
    const actual = canonical(`class Terminal { ${result.slice(start, end + 1)} }`);
    if (actual === canonical(`class Terminal { ${native} }`))
      result = result.slice(0, start) + patched + result.slice(end + 1);
    else if (actual !== canonical(`class Terminal { ${patched} }`))
      throw new Error(`${file}: terminal close ownership or patch changed`);
  }
  if (result === content && !hadMarker && !hadBehavior)
    throw new Error(`${file}: no terminal capability target`);
  if (hadMarker && result !== content)
    throw new Error(`${file}: historical or partial terminal patch`);
  if (hadBehavior && !hadMarker && !isGatewayBundlePath(file))
    throw new Error(`${file}: terminal patch marker missing`);
  return hadMarker || isGatewayBundlePath(file) ? result : `// ${CONTRACT}\n` + result;
}
function processTargets(root, verify) {
  const groups = [
    ['TerminalOpenParamsSchema =', 2],
    ['const spawnPlan = resolveTerminalOpenSpawnPlan(', 2],
    ['close(connId, sessionId) {', 2],
  ];
  const files = new Set([
    ...findFilesContaining(root, CONTRACT),
    ...findFilesContaining(root, 'justDoTerminal'),
  ]);
  for (const [anchor] of groups)
    for (const file of findFilesContaining(root, anchor)) files.add(file);
  const contents = [...files].map(file => ({ file, original: fs.readFileSync(file, 'utf8') }));
  if (fs.existsSync(path.join(root, 'gateway-bundle.mjs'))) {
    const bundle = contents.find(entry => isGatewayBundlePath(entry.file));
    if (
      !bundle ||
      !bundle.original.includes('TerminalOpenParamsSchema =') ||
      (!bundle.original.includes('const spawnPlan = resolveTerminalOpenSpawnPlan(') &&
        !bundle.original.includes('justDoTerminalLaunch')) ||
      (!bundle.original.includes('close(connId, sessionId) {') &&
        !bundle.original.includes('justDoTerminalTerminate'))
    ) {
      throw new Error('Terminal capability is incomplete in the Gateway bundle');
    }
  }
  const sources = contents.filter(entry => !isGatewayBundlePath(entry.file));
  if (
    sources.some(entry => entry.original.includes(CONTRACT)) &&
    sources.some(entry => !entry.original.includes(CONTRACT))
  ) {
    throw new Error('Mixed pristine and patched terminal capability; rebuild the locked runtime');
  }
  for (const [anchor, count] of groups) {
    const key = anchor.startsWith('const spawnPlan')
      ? 'justDoTerminalLaunch'
      : anchor.startsWith('close(')
        ? 'justDoTerminalTerminate'
        : anchor;
    const sources = contents.filter(
      entry =>
        !isGatewayBundlePath(entry.file) &&
        (entry.original.includes(anchor) || entry.original.includes(key)),
    );
    if (sources.length !== count)
      throw new Error(
        `Terminal capability ${anchor}: source count ${sources.length}, expected ${count}`,
      );
  }
  const plans = contents.map(entry => ({
    ...entry,
    patched: transform(entry.original, entry.file),
  }));
  if (verify) {
    for (const entry of plans)
      if (entry.original !== entry.patched)
        throw new Error(`${entry.file}: terminal patch missing`);
    return [];
  }
  return plans
    .filter(entry => writeIfChanged(entry.file, entry.original, entry.patched))
    .map(entry => path.relative(root, entry.file));
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform },
};
