import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const admissionPatch = require('../../../../scripts/patches/v2026.10.7/026-scoped-finalize-hook-admission.cjs').__testing;
const reasoningPatch = require('../../../../scripts/patches/v2026.10.7/028-reasoning-completions-streaming.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const version = '2026.10.7';
const nativeOwner = 'dist/builtin-openclaw-Ci5YBsOb.mjs';
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';
function targetRuntime(requested: string | undefined, explicit: boolean) {
  if (!requested) return undefined;
  try {
    const physicalRoot = fs.realpathSync(requested);
    const metadata = JSON.parse(fs.readFileSync(path.join(physicalRoot, 'package.json'), 'utf8'));
    if (metadata.name === 'openclaw' && metadata.version === version) return physicalRoot;
    throw new Error(`Expected openclaw@${version}, received ${metadata.name}@${metadata.version}`);
  } catch (error) {
    if (explicit) throw new Error('Target subscription runtime admission failed', { cause: error });
    return undefined;
  }
}
const pristine = targetRuntime(process.env.JUSTDO_EXECUTION_PRISTINE_DIR, true);
const preparedRuntime = path.resolve('vendor/openclaw-runtime/current');
const frozenRuntime = targetRuntime(process.env.JUSTDO_EXECUTION_RUNTIME ??
  (!pristine && fs.existsSync(path.join(preparedRuntime, 'gateway-bundle.mjs'))
    ? preparedRuntime : undefined), Boolean(process.env.JUSTDO_EXECUTION_RUNTIME));
const runtime = frozenRuntime ?? pristine;
const runtimeNodeModulesRoot = targetRuntime(process.env.OPENCLAW_RUNTIME_DIR, true) ?? runtime;
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

it.skipIf(!required && !runtime)('admits the exact .7 native subscription graph', () => {
  if (required) expect(process.env.JUSTDO_EXECUTION_RUNTIME ?? process.env.JUSTDO_EXECUTION_PRISTINE_DIR,
    'Required native subscription validation must explicitly select its target').toBeTruthy();
  expect(runtime, 'OPENCLAW_RUNTIME_CONTRACT_REQUIRED needs an explicit .7 runtime').toBeDefined();
  expect(fs.statSync(path.join(runtime!, nativeOwner)).isFile()).toBe(true);
  expect(fs.statSync(path.join(runtimeNodeModulesRoot!, 'node_modules')).isDirectory()).toBe(true);
  if (frozenRuntime) expect(fs.statSync(path.join(frozenRuntime, 'gateway-bundle.mjs')).isFile()).toBe(true);
});

type NativeEvent = { stream: string; data: Record<string, unknown>; transcriptStart?: unknown };
type Subscription = { unsubscribe(): void; waitForPendingEvents(): Promise<void> };
type NativeSubscriber = {
  subscribeEmbeddedAgentSession(params: object): Subscription;
  sessionManagerReadTranscriptStart: symbol;
  fixtureErrors: string[];
};

function subscriptionRange(source: string, file: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = ast.statements.filter((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'subscribeEmbeddedAgentSession');
  expect(matches).toHaveLength(1);
  const node = matches[0];
  return { start: node.getStart(ast), end: node.end, text: node.getText(ast) };
}

function withoutPolicyForwarder(source: string, file: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const getters: ts.GetAccessorDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isGetAccessor(node) && node.name.getText(ast) === 'deferTerminalDelivery') getters.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(getters).toHaveLength(1);
  const getter = getters[0];
  expect(ts.isObjectLiteralExpression(getter.parent)).toBe(true);
  const properties = (getter.parent as ts.ObjectLiteralExpression).properties;
  const following = properties[properties.indexOf(getter) + 1];
  expect(following).toBeDefined();
  // Remove only the forwarding accessor in memory. The unchanged spread then
  // captures the pre-lock policy, reproducing the native subscription defect.
  return source.slice(0, getter.getStart(ast)) + source.slice(following.getStart(ast));
}

// Load the actual subscription entry and its native message/lifecycle/delivery
// dependencies, rather than substituting the subscription call as older tests did.
function nativeDeclarationClosure(source: string, file: string, names: string[]) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const stubs: Record<string, string> = {
    sessionManagerReadTranscriptStart: 'Symbol("fixture-transcript-start")',
    resolveEmbeddedAgentSessionLogger: '() => ({ debug(message) { if (message.includes("handler failed")) fixtureErrors.push(message); }, info() {}, warn(message) { fixtureErrors.push(message); } })',
    createEmbeddedModelState: '() => ({ captureModelEvent() {}, recordAuxiliaryUsage() {}, getUsageTotals() {}, getLastAssistantUsage() {}, getCurrentAttemptAssistant() {}, hasSuccessfulModelResponse() { return false; } })',
    setSessionModelUsageSink: '() => {}',
    cleanupRunToolStartData: '() => {}',
    createEmbeddedToolLifecycleRunner: '() => ({})',
    recordEmbeddedToolTrajectoryEvent: '() => {}',
  };
  // Tool execution, model accounting and error formatting do not participate in
  // this text-only fixture. Keep native subscription, admission, dispatcher,
  // agent start/end, message handlers, stream state and reply delivery intact.
  const unused = [
    'handleToolExecutionStart', 'handleToolExecutionUpdate', 'handleToolExecutionEnd',
    'handleCompactionStart', 'handleCompactionEnd', 'consumeEmbeddedToolReceipt',
    'prepareToolResult', 'classifyAssistantFailoverReason', 'formatUserFacingAssistantErrorText',
    'buildApiErrorObservationFields', 'buildTextObservationFields', 'projectChatErrorDetail',
    'sanitizeForConsole', 'summarizeToolValidationError', 'shouldSuppressRawErrorConsoleSuffix', 'finalizeToolActivity',
  ];
  for (const name of unused) stubs[name] = `() => { throw new Error('Unexpected fixture collaborator: ${name}'); }`;
  stubs.finalizeToolActivity = '() => {}';
  const stubFor = (name: string) => stubs[name] ?? stubs[name.replace(/(?:\$\d+|\d+)$/, '')];
  const declarations = new Map<string, ts.Statement>();
  const overrideStatements = new Map<ts.Statement, string>();
  const addStub = (name: string) => {
    const replacement = stubFor(name);
    if (!replacement) return false;
    const text = `const ${name} = ${replacement};`;
    const statement = ts.createSourceFile('stub.mjs', text, ts.ScriptTarget.Latest, true).statements[0];
    declarations.set(name, statement);
    overrideStatements.set(statement, text);
    return true;
  };
  const register = (name: ts.BindingName, statement: ts.Statement) => {
    if (ts.isIdentifier(name)) {
      if (!addStub(name.text)) declarations.set(name.text, statement);
    }
    else for (const element of name.elements)
      if (ts.isBindingElement(element)) register(element.name, statement);
  };
  for (const statement of ast.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      if (!addStub(statement.name.text)) declarations.set(statement.name.text, statement);
    }
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) register(declaration.name, statement);
    else if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.name) declarations.set(statement.importClause.name.text, statement);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        const kept = bindings.elements.filter(element => !stubFor(element.name.text));
        const filtered = kept.length === bindings.elements.length ? statement : ts.factory.updateImportDeclaration(
          statement, statement.modifiers, ts.factory.updateImportClause(statement.importClause!,
            false, statement.importClause!.name, ts.factory.updateNamedImports(bindings, kept)),
          statement.moduleSpecifier, statement.attributes);
        overrideStatements.set(filtered, ts.createPrinter().printNode(ts.EmitHint.Unspecified, filtered, ast));
        for (const element of bindings.elements)
          if (!addStub(element.name.text)) declarations.set(element.name.text, filtered);
      } else if (bindings) declarations.set(bindings.name.text, statement);
    }
  }
  const selected = new Set<ts.Statement>();
  const selectedImports = new Map<ts.ImportDeclaration, Set<string>>();
  const add = (statement: ts.Statement) => {
    if (selected.has(statement)) return;
    selected.add(statement);
    if (ts.isImportDeclaration(statement)) return;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const declaration = declarations.get(node.text);
        if (declaration) {
          if (ts.isImportDeclaration(declaration)) {
            const bindings = selectedImports.get(declaration) ?? new Set<string>();
            bindings.add(node.text);
            selectedImports.set(declaration, bindings);
          }
          add(declaration);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  };
  for (const name of names) {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Native fixture declaration missing: ${name}`);
    add(declaration);
  }
  const print = (statement: ts.Statement) => {
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)) {
      const names = selectedImports.get(statement)!;
      const kept = statement.importClause.namedBindings.elements.filter(element => names.has(element.name.text));
      const filtered = ts.factory.updateImportDeclaration(statement, statement.modifiers,
        ts.factory.updateImportClause(statement.importClause, false, statement.importClause.name,
          ts.factory.updateNamedImports(statement.importClause.namedBindings, kept)),
        statement.moduleSpecifier, statement.attributes);
      return ts.createPrinter().printNode(ts.EmitHint.Unspecified, filtered, ast);
    }
    return overrideStatements.get(statement) ?? statement.getText(ast);
  };
  return 'const fixtureErrors = [];\n' + [...selected].sort((left, right) => left.pos - right.pos)
    .map(print).join('\n') +
    `\nexport { ${names.join(', ')}, fixtureErrors };`;
}

function textHelperOwner(source: string, file: string) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = ['resolveFinalAssistantRawText', 'resolveFinalAssistantVisibleText'];
  const imports: { file: string; local: string; exported: string }[] = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const entry of bindings.elements) if (names.includes(entry.name.text)) {
      expect(statement.moduleSpecifier.text.startsWith('./')).toBe(true);
      imports.push({ file: path.resolve(path.dirname(file), statement.moduleSpecifier.text),
        local: entry.name.text, exported: (entry.propertyName ?? entry.name).text });
    }
  }
  expect(imports.map(entry => entry.local).sort()).toEqual([...names].sort());
  expect(new Set(imports.map(entry => entry.file)).size).toBe(1);
  const helper = ts.createSourceFile(imports[0].file, fs.readFileSync(imports[0].file, 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const binding of imports) {
    const actual = helper.statements.flatMap(statement =>
      ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.filter(entry => entry.name.text === binding.exported)
        : []);
    expect(actual).toHaveLength(1);
    expect((actual[0].propertyName ?? actual[0].name).text).toBe(binding.local);
  }
  return { file: imports[0].file, names, exports: imports.map(entry => `${entry.local} as ${entry.exported}`) };
}

async function loadSubscriber(source: string, file: string): Promise<NativeSubscriber> {
  const helper = textHelperOwner(source, file);
  let helperLoads = 0;
  const contents = nativeDeclarationClosure(source, file,
    ['subscribeEmbeddedAgentSession', 'sessionManagerReadTranscriptStart']);
  const result = await build({
    stdin: { contents, resolveDir: path.dirname(file), sourcefile: 'native-subscription-fixture.mjs' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    nodePaths: [...new Set([path.join(runtime!, 'node_modules'), path.join(runtimeNodeModulesRoot!, 'node_modules')])],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(file).href) },
    plugins: [{ name: 'native-text-helper-closure', setup(builder) {
      builder.onLoad({ filter: /\.mjs$/ }, async args => {
        if (path.resolve(args.path) !== helper.file) return undefined;
        helperLoads++;
        return {
          contents: nativeDeclarationClosure(await fs.promises.readFile(args.path, 'utf8'), args.path, helper.names) +
            `\nexport { ${helper.exports.join(', ')} };`,
          loader: 'js',
        };
      });
    } }],
  });
  expect(helperLoads, 'The exact native text helper must be isolated once').toBe(1);
  const loaded = { exports: {} as NativeSubscriber };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(file), loaded, loaded.exports,
  );
  return loaded.exports;
}

const identity = {
  runId: 'subscription-stream-run', sessionId: 'subscription-native-session',
  sessionKey: 'agent:role:subscription-stream', agentId: 'role',
};

describe.skipIf(!runtime)('actual native subscription finalization admission', () => {
  let native: NativeSubscriber;
  let control: NativeSubscriber | undefined;
  let policy: (admission: { required: boolean }, enabled: boolean) => { readonly deferTerminalDelivery: boolean };
  const subscriptions: Subscription[] = [];
  const immutableFiles = new Map<string, string>();
  const remember = (file: string) => immutableFiles.set(file, hash(file));

  beforeAll(async () => {
    if (frozenRuntime) {
      const bundleFile = path.join(frozenRuntime, 'gateway-bundle.mjs');
      remember(bundleFile);
      const bundle = fs.readFileSync(bundleFile, 'utf8');
      // Verify the final Gateway copy without retaining its entire 70+ MB AST.
      // Execute the same immutable artifact's native owner and dependencies below.
      expect(admissionPatch.transform(bundle, bundleFile)).toBe(bundle);
    }
    const file = path.join(runtime!, nativeOwner);
    remember(file);
    const original = fs.readFileSync(file, 'utf8');
    if (!frozenRuntime) {
      const targets = require('../../../../scripts/patches/v2026.10.7/pristine-targets.json').targets;
      expect(hash(file)).toBe(targets.find((target: { file: string }) => target.file === nativeOwner)?.sha256);
    }
    remember(textHelperOwner(original, file).file);
    const admitted = admissionPatch.transform(original, file);
    if (frozenRuntime) expect(admitted).toBe(original);
    const source = frozenRuntime ? original : reasoningPatch.transform(admitted, file);
    const prepare = ts.createSourceFile('prepare.mjs', functionRange(source, 'prepareStream').text,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const getters: ts.GetAccessorDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isGetAccessor(node) && node.name.getText(prepare) === 'deferTerminalDelivery') getters.push(node);
      ts.forEachChild(node, visit);
    };
    visit(prepare);
    expect(getters).toHaveLength(1);
    policy = new Function('runFinalizeAdmission', 'shouldRunBeforeAgentFinalize',
      `return ({${getters[0].getText(prepare)}});`) as typeof policy;
    native = await loadSubscriber(source, file);
    // Keep a negative control in ordinary prepared-runtime runs as well as in
    // pristine audits. Frozen artifacts are never modified on disk.
    const current = subscriptionRange(source, file);
    const previous = frozenRuntime ? withoutPolicyForwarder(current.text, file)
      : subscriptionRange(original, file).text;
    control = await loadSubscriber(source.slice(0, current.start) + previous + source.slice(current.end), file);
  }, 60_000);

  afterAll(() => {
    for (const [file, originalHash] of immutableFiles) expect(hash(file), file).toBe(originalHash);
  });

  afterEach(() => {
    for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
    if (native) expect(native.fixtureErrors).toEqual([]);
    if (control) expect(control.fixtureErrors).toEqual([]);
  });

  function setup(options: { owned?: boolean; lock?: boolean; callback?: boolean; api?: NativeSubscriber } = {}) {
    const api = options.api ?? native;
    const selected = vi.fn(() => options.owned === true);
    const admission = admissionPatch.createFinalizeHookAdmission({ typedHooks: [{
      hookName: 'before_agent_finalize', appliesToAgentRun: selected, handler: vi.fn(),
    }] }, vi.fn());
    const transcriptStart = { id: 'native-transcript-start' };
    const readTranscriptStart = vi.fn(() => transcriptStart);
    const events: NativeEvent[] = [];
    const onPartialReply = vi.fn();
    const onBlockReply = vi.fn();
    const onBeforeTerminalDelivery = vi.fn();
    let receive!: (event: object) => unknown;
    const sessionUnsubscribe = vi.fn();
    const session = {
      id: identity.sessionId,
      sessionManager: { [api.sessionManagerReadTranscriptStart]: readTranscriptStart },
      subscribe(handler: typeof receive) { receive = handler; return sessionUnsubscribe; },
    };
    const params = policy(admission, true);
    Object.assign(params, identity, {
      session, onPartialReply, onBlockReply, onBeforeTerminalDelivery,
      blockReplyBreak: 'message_end', blockReplyChunking: { minChars: 1, maxChars: 100 },
      ...(options.callback === false ? {} : { onAgentEvent: (event: NativeEvent) => events.push(structuredClone(event)) }),
    });
    expect(params.deferTerminalDelivery).toBe(true);
    const subscription = api.subscribeEmbeddedAgentSession(params);
    subscriptions.push(subscription);
    // Native prepareStream subscribes first; prompt preparation then fixes the
    // applicable registrations before agent_start and before any model output.
    if (options.lock !== false) admission.lock(identity);
    return {
      events, admission, selected, subscription, onPartialReply, onBlockReply, onBeforeTerminalDelivery,
      readTranscriptStart, transcriptStart, sessionUnsubscribe,
      async send(event: object) { receive(event); await subscription.waitForPendingEvents(); },
    };
  }

  function message(text: string, structured: boolean) {
    return {
      role: 'assistant', api: 'openai-completions', stopReason: 'stop',
      content: [{ type: 'text', text }],
      ...(structured ? { openclawDelivery: {
        textPhaseRequiresTerminal: true, structuredTextStreaming: true, messageScopeId: 'normalized-source',
      } } : {}),
    };
  }

  async function update(h: ReturnType<typeof setup>, text: string, delta: string, structured: boolean) {
    const partial = message(text, structured);
    await h.send({ type: 'message_update', message: partial,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial } });
  }

  const bodies = (h: ReturnType<typeof setup>) => h.events.filter(event => event.stream === 'assistant');

  it.each([false, true])('streams two incremental previews before terminal after exclusion; structured=%s', async structured => {
    const h = setup();
    expect(h.admission.required).toBe(false);
    expect(h.selected).toHaveBeenCalledOnce();
    await h.send({ type: 'agent_start' });
    await h.send({ type: 'message_start', message: message('', structured) });
    await update(h, 'Alpha ', 'Alpha ', structured);
    expect(bodies(h).at(-1)?.data.text).toBe('Alpha');
    await update(h, 'Alpha Beta', 'Beta', structured);
    expect(bodies(h).at(-1)?.data.text).toBe('Alpha Beta');
    expect(h.onBeforeTerminalDelivery).not.toHaveBeenCalled();
    expect(h.onBlockReply).not.toHaveBeenCalled();
    if (structured) expect(h.onPartialReply).not.toHaveBeenCalled();
    expect(h.readTranscriptStart).toHaveBeenCalledOnce();
    expect(h.events.filter(event => event.transcriptStart !== undefined)).toHaveLength(1);
    expect(h.events[0].transcriptStart).toEqual(h.transcriptStart);
    // A same-attempt restart must continue to read the frozen exclusion.
    await h.send({ type: 'agent_start' });
    await h.send({ type: 'message_start', message: message('', structured) });
    await update(h, 'Next.', 'Next.', structured);
    expect(bodies(h).at(-1)?.data.text).toBe('Next.');
    expect(h.selected).toHaveBeenCalledOnce();
  });

  it.each(['owned', 'unlocked'] as const)('keeps %s finalization protected before terminal', async mode => {
    const h = setup({ owned: mode === 'owned', lock: mode !== 'unlocked' });
    await h.send({ type: 'agent_start' });
    await h.send({ type: 'message_start', message: message('', true) });
    await update(h, 'Protected ', 'Protected ', true);
    await update(h, 'Protected answer.', 'answer.', true);
    expect(h.admission.required).toBe(true);
    expect(bodies(h)).toEqual([]);
    expect(h.onPartialReply).not.toHaveBeenCalled();
    expect(h.onBlockReply).not.toHaveBeenCalled();
    expect(h.onBeforeTerminalDelivery).not.toHaveBeenCalled();
    expect(h.selected).toHaveBeenCalledTimes(mode === 'owned' ? 1 : 0);
  });

  it('preserves the no-agent-callback path and subscription cleanup', async () => {
    const h = setup({ callback: false });
    await h.send({ type: 'agent_start' });
    await h.send({ type: 'message_start', message: message('', false) });
    await update(h, 'Visible.', 'Visible.', false);
    expect(h.onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'Visible.' }));
    expect(h.readTranscriptStart).not.toHaveBeenCalled();
    h.subscription.unsubscribe();
    h.subscription.unsubscribe();
    expect(h.sessionUnsubscribe).toHaveBeenCalledOnce();
  });

  it('reproduces terminal buffering through the native clone without policy forwarding', async () => {
    const h = setup({ api: control });
    await h.send({ type: 'agent_start' });
    await h.send({ type: 'message_start', message: message('', false) });
    await update(h, 'Alpha ', 'Alpha ', false);
    await update(h, 'Alpha Beta', 'Beta', false);
    expect(h.admission.required).toBe(false);
    expect(bodies(h)).toEqual([]);
    expect(h.onPartialReply).not.toHaveBeenCalled();
    await h.send({ type: 'message_end', message: message('Alpha Beta', false) });
    await h.send({ type: 'agent_end', messages: [] });
    expect(h.onBeforeTerminalDelivery).toHaveBeenCalledOnce();
    expect(bodies(h).at(-1)?.data.text).toBe('Alpha Beta');
  });
});
