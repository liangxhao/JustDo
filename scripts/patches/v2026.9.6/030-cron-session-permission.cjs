'use strict';

// Capability: persist per-task native session permission modes and apply them on every run.
// Target: openclaw@2026.9.6 cron schema, payload merge, RPC handlers and isolated runner.
// Scope: explicit admin-authored isolated agent-turn jobs; no agent or global override.
// Safety: only unscoped operator.admin can author modes, edit or manually run Full jobs.
// Remove when: upstream cron supports per-run native session permission modes.
const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  writeIfChanged,
  normalizeJustDoGatewayBundle,
} = require('./_patch-utils.js');

const PREFIX = 'JUSTDO_CRON_SESSION_PERMISSION_V2026_9_6';
const guard = `function justDoCronPermissionGuard(job, client, scoped, respond, explicit = false) {
  const mode = job?.payload?.permissionMode;
  if (mode !== undefined && (job.payload.kind !== "agentTurn" || job.sessionTarget !== "isolated")) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "Scheduled session permissions require an isolated agent-turn job." });
    return false;
  }
  if (!explicit && mode !== "full") return true;
  if (!client?.connect?.scopes?.includes("operator.admin") || scoped) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "Scheduled session permissions require an unscoped operator.admin client." });
    return false;
  }
  return true;
}`;

function once(text, regex, replace, label) {
  const matches = [...text.matchAll(new RegExp(regex.source, 'g'))];
  if (matches.length !== 1) throw new Error(`${label}: expected one anchor, got ${matches.length}`);
  return text.replace(regex, replace);
}

function inFunction(text, name, edit) {
  return once(text, new RegExp(`function ${name}\\([^]*?\\n\\}`), edit, name);
}

function schema(text) {
  return inFunction(text, 'cronAgentTurnPayloadSchema', body =>
    once(
      body,
      /toolsAllow: ([\w$]+)\.Optional\(params\.toolsAllow\),/,
      (anchor, type) =>
        `permissionMode: ${type}.Optional(${type}.Union([${type}.Literal("read-only"), ${type}.Literal("full")])),\n${anchor}`,
      'permission schema',
    ),
  );
}

function merge(text) {
  text = inFunction(text, 'mergeCronPayload', body =>
    once(
      body,
      /if \(typeof patch\.message === "string"\)/,
      'if (patch.permissionMode !== undefined) next.permissionMode = patch.permissionMode;\nif (typeof patch.message === "string")',
      'permission update',
    ),
  );
  return inFunction(text, 'buildPayloadFromPatch', body =>
    once(
      body,
      /message: patch\.message,/,
      'message: patch.message,\n...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),',
      'permission replacement',
    ),
  );
}

function prepare(text) {
  return once(
    text,
    /const cronSession = resolveCronSession\(\{[^]*?\n\s*\}\);/,
    anchor => `${anchor}\nif (input.job.payload.kind === "agentTurn" && input.job.payload.permissionMode !== undefined) {
  if (input.job.sessionTarget !== "isolated" || !["read-only", "full"].includes(input.job.payload.permissionMode)) throw new Error("Invalid scheduled session permission mode");
  cronSession.sessionEntry.permissionMode = input.job.payload.permissionMode;
  cronSession.sessionEntry.sessionRoot = workspaceDir;
}`,
    'native session permission',
  );
}

function execute(text) {
  return once(
    text,
    /toolsAllow: params\.agentPayload\?\.toolsAllow,\s*scheduledRuntimeAuthority: params\.job\.runtimeAuthority,/,
    anchor =>
      `permissionMode: params.cronSession.sessionEntry.permissionMode,\nsessionRoot: params.cronSession.sessionEntry.sessionRoot,\n${anchor}`,
    'embedded run permission',
  );
}

function handlers(text) {
  for (const method of ['add', 'update', 'run']) {
    const start = text.indexOf(`"cron.${method}": async (`);
    if (start < 0) throw new Error(`missing cron.${method} handler`);
    const end = text.indexOf('\n', text.indexOf('=> {', start));
    const header = text.slice(start, end);
    const client = /\bclient(?::\s*([\w$]+))?/.exec(header);
    if (!client) throw new Error(`missing cron.${method} client`);
    const clientName = client[1] || 'client';
    const respondName = /\brespond(?::\s*([\w$]+))?/.exec(header)?.[1] || 'respond';
    // Bound the edit by the next handler; nested function bodies remain untouched.
    const following = text.slice(end).search(/\n\s*"[\w.]+": async /);
    const stop = following < 0 ? text.length : end + following;
    let body = text.slice(start, stop);
    const check = (job, explicit) =>
      `if (!justDoCronPermissionGuard(${job}, ${clientName}, readCronCallerScope(${clientName}), ${respondName}, ${explicit})) return;`;
    if (method === 'add') {
      const jobCreate = /const (jobCreate\w*) = applyCronCreateCallerScopeDefault/.exec(body)?.[1] || 'jobCreate';
      body = once(
        body,
        /const (candidate\w*) = normalized\w*;/,
        (anchor, candidate) =>
          `${anchor}\n${check(candidate, `${candidate}?.payload?.permissionMode !== undefined`)}`,
        'cron.add authority',
      );
      body = once(body, /matchesExisting: \((\w+)\) =>\s*(cronJobMatchesDeclarationScope\(\{[^]*?\}\))(,?)/,
        (_anchor, job, match, comma) => `matchesExisting: (${job}) => {
  const justDoMatches = ${match};
  if (!justDoMatches) return false;
  const justDoDeny = function(ok, data, error) { throw new TypeError(error.message); };
  if (!justDoCronPermissionGuard(${job}, ${clientName}, readCronCallerScope(${clientName}), justDoDeny, false)) return false;
  if (!justDoCronPermissionGuard({ ...${job}, payload: ${jobCreate}.payload }, ${clientName}, readCronCallerScope(${clientName}), justDoDeny, ${jobCreate}.payload.permissionMode !== undefined)) return false;
  return true;
}${comma}`, 'locked cron.add upsert authority');
    } else {
      body = once(body, /const ([\w$]+) = await ([\w$]+)\.cron\.readJob\(jobId\);/,
        (anchor, job) => `${anchor}\n${check(job, 'false')}`, `cron.${method} authority`);
      if (method === 'update') {
        const patchName = /const (patch\w*) = normalizedPatch/.exec(body)?.[1] || 'patch';
        body = once(body, /const ([\w$]+) = await assertValidCronUpdatePatch\(\{[^]*?currentJob: ([\w$]+),[^]*?\}\);/,
          (anchor, nextJob, currentJob) => {
            const deny = 'function(ok, data, error) { throw new TypeError(error.message); }';
            return `${anchor}\nif (!justDoCronPermissionGuard(${currentJob}, ${clientName}, readCronCallerScope(${clientName}), ${deny}, false)) return;\nif (!justDoCronPermissionGuard(${nextJob}, ${clientName}, readCronCallerScope(${clientName}), ${deny}, ${patchName}.payload?.permissionMode !== undefined)) return;`;
          }, 'locked cron.update authority');
      } else {
        const contextName = /await ([\w$]+)\.cron\.readJob\(jobId\)/.exec(body)?.[1];
        body = once(body, /const (commitGuard\w*) = (resolveCronMutationCommitGuard\([^]*?\}\));/,
          (_anchor, commit, original) => `const justDoNativeRunGuard = ${original};
const ${commit} = () => {
  justDoNativeRunGuard?.();
  const justDoCurrentJob = ${contextName}.cron.getJob(jobId);
  if (!justDoCronPermissionGuard(justDoCurrentJob, ${clientName}, readCronCallerScope(${clientName}), function(ok, data, error) { throw new TypeError(error.message); }, false)) return;
};`, 'locked cron.run authority');
      }
    }
    text = text.slice(0, start) + body + text.slice(stop);
  }
  return `${text}\n${guard}\n`;
}

const seams = [
  { name: 'SCHEMA', anchor: 'function cronAgentTurnPayloadSchema(', edit: schema },
  { name: 'MERGE', anchor: 'function mergeCronPayload(', edit: merge },
  { name: 'PREPARE', anchor: 'const cronSession = resolveCronSession({', edit: prepare },
  {
    name: 'EXECUTE',
    anchor: 'scheduledRuntimeAuthority: params.job.runtimeAuthority',
    edit: execute,
  },
  { name: 'HANDLERS', anchor: '"cron.add": async (', edit: handlers },
];

function strip(text, seam) {
  if (seam.name === 'SCHEMA')
    return inFunction(text, 'cronAgentTurnPayloadSchema', body =>
      body.replace(/permissionMode: [^;]*?Literal\("full"\)\]\)\),\s*/g, ''),
    );
  if (seam.name === 'MERGE')
    return inFunction(
      inFunction(text, 'mergeCronPayload', body =>
        body.replace(
          /if \(patch\.permissionMode !== (?:undefined|void 0)\) next\.permissionMode = patch\.permissionMode;\s*/g,
          '',
        ),
      ),
      'buildPayloadFromPatch',
      body =>
        body.replace(
          /\.\.\.\(?patch\.permissionMode !== (?:undefined|void 0) \? \{ permissionMode: patch\.permissionMode \} : \{\}\)?,\s*/g,
          '',
        ),
    );
  if (seam.name === 'EXECUTE')
    return text.replace(
      /permissionMode: params\.cronSession\.sessionEntry\.permissionMode,\s*sessionRoot: params\.cronSession\.sessionEntry\.sessionRoot,\s*/g,
      '',
    );
  if (seam.name === 'PREPARE')
    return text.replace(
      /if \(input\.job\.payload\.kind === "agentTurn" && input\.job\.payload\.permissionMode !== (?:undefined|void 0)\) \{[^]*?cronSession\.sessionEntry\.sessionRoot = workspaceDir;\s*\}\s*/g,
      '',
    );
  return text
    .replace(/matchesExisting: \((\w+)\) => \{\s*const justDoMatches = (cronJobMatchesDeclarationScope\(\{[^]*?\}\));[^]*?return true;\s*\}(,?)/g,
      'matchesExisting: ($1) => $2$3')
    .replace(/const justDoNativeRunGuard = (resolveCronMutationCommitGuard\([^]*?\}\));\s*const (commitGuard\w*) = \(\) => \{[^]*?\n\s*\};/g,
      'const $2 = $1;')
    .replace(/if \(!justDoCronPermissionGuard\([^]*?\)\) return;\s*/g, '')
    .replace(/function justDoCronPermissionGuard\([^]*?\n\}/g, '');
}

function transform(text, seam) {
  const knownMarkers = new Set(seams.map(entry => `${PREFIX}_${entry.name}`));
  for (const [found] of text.matchAll(/JUSTDO_CRON_SESSION_PERMISSION_[A-Z0-9_]+/g)) {
    if (!knownMarkers.has(found)) throw new Error(`${seam.name}: historical or unknown cron permission marker`);
  }
  const marker = `/*${PREFIX}_${seam.name}*/`;
  if (text.split(marker).length > 2) throw new Error(`${seam.name}: duplicate patch markers`);
  const clean = text.replace(marker, '');
  const original = strip(clean, seam);
  const expected = seam.edit(original);
  const normalized = value => {
    let code = normalizeJustDoGatewayBundle(value).replace(/undefined/g, 'void0');
    code = code.replace(/\.\.\.\((patch\.permissionMode!==void0\?\{permissionMode:patch\.permissionMode\}:\{\})\)/g, '...$1');
    code = code.replace(/function\((\w+),(\w+),(\w+)\)\{thrownewTypeError\(\3\.message\);\}/g,
      'function(ok,data,error){thrownewTypeError(error.message);}');
    const helper = /functionjustDoCronPermissionGuard\((job\d*),(client\d*),(scoped\d*),(respond\d*),(explicit\d*)=false\)\{[^]*?returntrue;\}/.exec(code);
    if (helper) {
      let canonicalHelper = helper[0];
      for (const [index, name] of ['job', 'client', 'scoped', 'respond', 'explicit'].entries()) {
        canonicalHelper = canonicalHelper.replace(new RegExp(`\\b${helper[index + 1]}\\b`, 'g'), name);
      }
      code = code.replace(helper[0], '') + canonicalHelper;
    }
    return code;
  };
  if (normalized(original) !== normalized(clean) || text.includes(marker)) {
    if (normalized(clean) !== normalized(expected))
      throw new Error(`${seam.name}: historical or partial cron permission patch`);
    return text.includes(marker) ? text : `${text}\n${marker}\n`;
  }
  return `${expected}\n${marker}\n`;
}

function targets(runtimeDir) {
  const result = new Map();
  for (const seam of seams) {
    const files = findFilesContaining(runtimeDir, [seam.anchor]).filter(file => !file.includes(`${path.sep}worker${path.sep}`));
    if (
      fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) &&
      !files.includes(path.join(runtimeDir, 'gateway-bundle.mjs'))
    )
      throw new Error(`Missing cron permission ${seam.name} bundle`);
    if (!files.some(file => path.basename(file) !== 'gateway-bundle.mjs'))
      throw new Error(`Missing cron permission ${seam.name} source`);
    for (const file of files) result.set(file, [...(result.get(file) || []), seam]);
  }
  return result;
}

function applyPatch(runtimeDir) {
  const changed = [];
  for (const [file, applicable] of targets(runtimeDir)) {
    const original = fs.readFileSync(file, 'utf8');
    const updated = applicable.reduce((text, seam) => transform(text, seam), original);
    if (writeIfChanged(file, original, updated)) changed.push(path.relative(runtimeDir, file));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const [file, applicable] of targets(runtimeDir)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const seam of applicable) {
      if (!text.includes(`/*${PREFIX}_${seam.name}*/`))
        throw new Error(`${file}: missing ${seam.name}`);
      if (transform(text, seam) !== text) throw new Error(`${file}: incomplete ${seam.name}`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { seams, transform, guard, schema, merge, prepare, execute, handlers },
};
