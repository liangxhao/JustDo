import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const { __testing: { transformAccessor, transformHandler, transformSchema } } = require('../../../../scripts/patches/v2026.10.6/012-managed-session-fork-target-key.cjs');
// Exact target resolver; forwarding fixture follows the native shared intent path.
const native = "function resolveMessageCut(events, entryId) {\n\tconst tree = scanSessionTranscriptTree(events);\n\tconst target = tree.byId.get(entryId);\n\tif (!target) return { status: \"missing-entry\" };\n\tconst record = asOptionalRecord(target.entry);\n\tconst message = asOptionalRecord(record?.message);\n\tif (record?.type !== \"message\" || message?.role !== \"user\") return { status: \"not-user-message\" };\n\tconst activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId);\n\tconst targetIndex = activePath.findIndex((node) => node.id === entryId);\n\tif (targetIndex < 0) return { status: \"off-active-path\" };\n\tconst prefix = [];\n\tfor (const node of activePath.slice(0, targetIndex)) {\n\t\tconst entry = asOptionalRecord(node.entry);\n\t\tprefix.push(entry && entry.parentId !== node.parentId ? {\n\t\t\t...entry,\n\t\t\tparentId: node.parentId\n\t\t} : node.entry);\n\t}\n\tconst editorAttachments = extractEditorAttachments(message.content);\n\tconst editorMediaRefs = extractEditorMediaRefs(message);\n\treturn {\n\t\tstatus: \"cut\",\n\t\teditorText: readMessageWorkContext(message)?.text ?? extractEditorText(message.content),\n\t\t...editorAttachments ? { editorAttachments } : {},\n\t\t...editorMediaRefs ? { editorMediaRefs } : {},\n\t\tparentId: target.parentId,\n\t\tprefix\n\t};\n}\nfunction forward(params, events) { const canonicalSourceKey = \"source\"; const intent = { canonicalSourceKey, creation: params.creation ? structuredClone(params.creation) : void 0, entryId: params.entryId, mode: params.mode }; return { intent, cut: resolveMessageCut(events, params.entryId) }; }";

test('shares includeEntry intent with workers and cuts only completed assistant responses', () => {
  const source = transformAccessor(native, 'message-cut.mjs');
  const previous = { id: 'user', parentId: null, entry: { type: 'message', message: { role: 'user', content: 'ask' } } };
  const target = { id: 'answer', parentId: 'user', entry: { type: 'message', message: { role: 'assistant', content: 'reply', stopReason: 'stop' } } };
  const tree = { byId: new Map([[previous.id, previous], [target.id, target]]), leafId: target.id };
  const forward = vm.runInNewContext(source + ';forward', {
    scanSessionTranscriptTree: () => tree, asOptionalRecord: (value: unknown) => value,
    selectSessionTranscriptTreePathNodes: () => [previous, target], extractEditorAttachments: () => ['attachment'],
    extractEditorMediaRefs: () => ['media'], readMessageWorkContext: () => undefined, extractEditorText: (value: unknown) => value,
  });
  const result = forward({ mode: 'fork', includeEntry: true, entryId: target.id }, []);
  expect(result.intent.includeEntry).toBe(true);
  expect(result.cut).toMatchObject({ status: 'cut', parentId: 'answer', prefix: [previous.entry, target.entry] });
  expect(result.cut.editorText).toBeUndefined();
  expect(result.cut.editorAttachments).toBeUndefined();
  expect(forward({ mode: 'rewind', includeEntry: true, entryId: target.id }, []).cut).toEqual({ status: 'not-user-message' });
  expect(forward({ mode: 'fork', includeEntry: false, entryId: target.id }, []).cut).toEqual({ status: 'not-user-message' });
  target.entry.message.stopReason = 'toolUse';
  expect(forward({ mode: 'fork', includeEntry: true, entryId: target.id }, []).cut).toEqual({ status: 'not-user-message' });
  expect(forward({ mode: 'rewind', entryId: previous.id }, []).cut).toMatchObject({ parentId: null, prefix: [], editorText: 'ask' });
  expect(transformAccessor(source, 'message-cut.mjs')).toBe(source);
  expect(() => transformAccessor(source.replaceAll('V2026_10_6', 'V2026_10_4'), 'message-cut.mjs')).toThrow();
});

test('extends the native closed fork schema with optional managed fields', () => {
  const source = 'const SessionsForkParamsSchema = closedObject(SessionsRewindParamsSchema.properties); const dummy={editorText:Type.Optional(Type.String())};';
  const patched = transformSchema(source, 'schema.mjs');
  const schema = vm.runInNewContext(patched + ';SessionsForkParamsSchema', {
    closedObject: (properties: unknown) => ({ properties }), SessionsRewindParamsSchema: { properties: { entryId: { type: 'string' } } },
    NonEmptyString: { type: 'string', minLength: 1 }, Type: { Optional: (value: object) => ({ ...value, '~optional': true }), String: () => ({ type: 'string' }) },
  });
  expect(schema.properties).toMatchObject({ entryId: { type: 'string' }, targetKey: { '~optional': true, minLength: 1 }, includeEntry: { '~optional': true, type: 'boolean' } });
  expect(transformSchema(patched, 'schema.mjs')).toBe(patched);
});

const nativeHandler = `async function mutateSessionAtMessage(options, action) {
  const { params, client, context, respond } = options;
  const cfg = context.getRuntimeConfig();
  const lifecycleIdentities = [params.key];
  const targetKey = action === "fork" ? buildDashboardSessionKey(current.target.agentId, { incognito: current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey) }) : current.canonicalKey;
  const upstreamLink = preparedUpstreamLink;
  resolveOperatorSessionCreation();
  if (upstreamLink) { const forkParams = { targetKey, upstream: true }; await forkUpstream(forkParams); }
  const mutationParams = { sessionKey: current.canonicalKey };
  const forkParams = { ...mutationParams, entryId, targetKey, repositoryWorkspaceId: forkRepository?.workspaceId, forkWorkspace: forkWorkspace?.value, creation: { ...creation, sandbox } };
  return await mutateSessionAtMessageWithPreconditions(action === "fork" ? forkParams : { ...mutationParams, entryId }, action, expectedState);
}`;

test('recognizes compiled fork forwarding by its selected key binding and native call', () => {
  const patched = transformHandler(nativeHandler, 'sessions.mjs');
  const renamed = patched.replace(/\btargetKey\b(?!\s*:)/gu, 'targetKey4')
    // Property access and the managed API parameter retain their public name.
    .replaceAll('.targetKey4', '.targetKey')
    .replaceAll('params.targetKey4', 'params.targetKey')
    .replaceAll('targetKey4,', 'targetKey: targetKey4,')
    .replaceAll('targetKey4 requires', 'targetKey requires')
    .replaceAll('targetKey4 must', 'targetKey must')
    .replaceAll('targetKey4 already', 'targetKey already')
    .replaceAll('requires targetKey4', 'requires targetKey');
  const compiled = transformSync(renamed, { legalComments: 'none' }).code;
  expect(transformHandler(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  for (const corrupt of [
    compiled.replace('targetKey: targetKey4,\n    includeEntry:', 'targetKey: unrelatedKey,\n    includeEntry:'),
    compiled.replace('includeEntry: requestedForkIncludeEntry,', 'includeEntry: requestedForkIncludeEntry, ...override,'),
    compiled.replace('action === "fork" ? forkParams :', 'action === "fork" ? unrelatedParams :'),
  ]) {
    expect(corrupt).not.toBe(compiled);
    expect(() => transformHandler(corrupt, 'gateway-bundle.mjs')).toThrow(/historical|partial/u);
  }
});
