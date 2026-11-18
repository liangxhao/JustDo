// Verbatim function excerpts from the locked openclaw@2026.10.7 package.
// Owners: mcp-ui-resource-BKPhtC8P.mjs, mcp-app-operations-1DuSfeoO.mjs, mcp-app-DRRDUDxP.mjs.
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const MCP_APP_RESOURCE_MAX_BYTES = 2097152;
const MCP_APP_VIEW_TTL_MS = 6e5;
const MCP_APP_VIEW_MAX_ENTRIES = 32;
const MCP_APP_VIEW_MAX_BYTES = 6291456;
const MCP_APP_VIEW_STORE_MAX_BYTES = 67108864;
const MCP_APP_VIEW_STORE_KEY = Symbol.for("openclaw.mcpAppViewStore");
function getViewStore() {
	return resolveGlobalMap(MCP_APP_VIEW_STORE_KEY);
}
function deleteView(viewId, expected) {
	const store = getViewStore();
	const view = store.get(viewId);
	if (!view || expected && view !== expected) return;
	clearTimeout(view.expiryTimer);
	view.toolApprovalGrants?.clear();
	clearMcpAppModelContextForView(view.runtime, view);
	notifyListeners(view.disposeCallbacks ?? [], void 0, (error) => {
		logWarn(`mcp-app: view cleanup failed: ${formatErrorMessage(error)}`);
	});
	view.disposeCallbacks?.clear();
	view.releaseRuntimeLease?.();
	store.delete(viewId);
	completeDeferredSessionMcpRuntimeRetirement(view.runtime).catch((error) => {
		logWarn(`mcp-app: deferred runtime cleanup failed: ${formatErrorMessage(error)}`);
	});
}
function pruneViewStore(additionalBytes = 0, reserveEntry = false) {
	const store = getViewStore();
	const nowMs = Date.now();
	for (const [viewId, view] of store) if (view.expiresAtMs <= nowMs) deleteView(viewId, view);
	let totalBytes = Array.from(store.values()).reduce((sum, view) => sum + (view.byteSize ?? 0), 0);
	while (store.size + (reserveEntry ? 1 : 0) > MCP_APP_VIEW_MAX_ENTRIES || totalBytes + additionalBytes > MCP_APP_VIEW_STORE_MAX_BYTES) {
		const oldest = store.keys().next().value;
		if (oldest === void 0) return;
		const evicted = store.get(oldest);
		totalBytes -= evicted?.byteSize ?? 0;
		if (evicted) deleteView(oldest, evicted);
	}
}
function measureViewBytes(html, toolInput, toolResult) {
	const toolData = JSON.stringify({
		toolInput,
		toolResult
	});
	const byteSize = Buffer.byteLength(html, "utf8") + Buffer.byteLength(toolData, "utf8");
	if (byteSize > MCP_APP_VIEW_MAX_BYTES) throw new Error(`MCP App view data exceeds ${MCP_APP_VIEW_MAX_BYTES} bytes`);
	return byteSize;
}
function assertBoundedViewDescriptor(value) {
	if (value.viewId && (value.viewId.length > 128 || !value.viewId.startsWith("mcp-app-")) || !value.serverName || value.serverName.length > 256 || !value.toolName || value.toolName.length > 256 || !value.uiResourceUri.startsWith("ui://") || value.uiResourceUri.length > 2048 || value.toolCallId !== void 0 && value.toolCallId.length > 512) throw new Error("MCP App preview descriptor exceeds safe limits");
}
function normalizePermissions(value) {
	const record = asOptionalRecord(value);
	if (!record) return;
	const permissions = {};
	for (const key of [
		"camera",
		"clipboardWrite",
		"geolocation",
		"microphone"
	]) if (asOptionalRecord(record[key])) permissions[key] = {};
	return Object.keys(permissions).length > 0 ? permissions : void 0;
}
function decodeResourceHtml(content) {
	if (typeof content.text === "string") {
		if (Buffer.byteLength(content.text, "utf8") > MCP_APP_RESOURCE_MAX_BYTES) throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
		return content.text;
	}
	if (typeof content.blob !== "string") throw new Error("MCP App resource must provide text or base64 blob content");
	const maxEncodedBytes = Math.ceil(MCP_APP_RESOURCE_MAX_BYTES / 3) * 4 + 4;
	if (content.blob.length > maxEncodedBytes) throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
	const decoded = Buffer.from(content.blob, "base64");
	if (decoded.byteLength > MCP_APP_RESOURCE_MAX_BYTES) throw new Error(`MCP App resource exceeds ${MCP_APP_RESOURCE_MAX_BYTES} bytes`);
	return decoded.toString("utf8");
}
async function resolveListingUiMeta(runtime, serverName, uri) {
	try {
		const listed = await runtime.listResources?.(serverName, { failureBackoff: "ignore" });
		const { _meta: metadata } = (Array.isArray(listed) ? listed : Array.isArray(asOptionalRecord(listed)?.resources) ? asOptionalRecord(listed)?.resources : []).map(asOptionalRecord).find((entry) => entry?.uri === uri) ?? {};
		return asOptionalRecord(asOptionalRecord(metadata)?.ui);
	} catch (error) {
		logWarn(`mcp-app: failed to read optional listing metadata for ${uri} from "${serverName}": ${formatErrorMessage(error)}`);
		return;
	}
}
async function fetchMcpAppView(params) {
	let releaseRuntimeLease;
	try {
		assertBoundedViewDescriptor(params);
		const agentId = params.agentId ? normalizeAgentId(params.agentId) : parseAgentSessionKey(params.runtime.sessionKey)?.agentId;
		if (!agentId) throw new Error("MCP App view requires a resolved session owner");
		if (!params.runtime.readResource) return;
		const result = asOptionalRecord(await params.runtime.readResource(params.serverName, params.uiResourceUri, { failureBackoff: "ignore" }));
		const contents = Array.isArray(result?.contents) ? result.contents : [];
		if (contents.length !== 1) throw new Error(`expected one MCP App resource, received ${contents.length}`);
		const content = asOptionalRecord(contents[0]);
		if (!content || content.mimeType !== MCP_APP_RESOURCE_MIME_TYPE) throw new Error(`resource must use ${MCP_APP_RESOURCE_MIME_TYPE}`);
		const html = decodeResourceHtml(content);
		const byteSize = measureViewBytes(html, params.toolInput, params.toolResult);
		const { _meta: metadata, meta: deprecatedMetadata } = content;
		const contentUiMeta = asOptionalRecord(asOptionalRecord(metadata ?? deprecatedMetadata)?.ui);
		const listingUiMeta = contentUiMeta ? void 0 : await resolveListingUiMeta(params.runtime, params.serverName, params.uiResourceUri);
		getSessionMcpRequestSignal()?.throwIfAborted();
		const uiMeta = contentUiMeta ?? listingUiMeta;
		const openaiUi = asOptionalRecord(asOptionalRecord(metadata)?.["openai/ui"]);
		const supportedModes = ["inline", "fullscreen"];
		const advertisedDisplayModes = openaiUi?.availableDisplayModes;
		const availableDisplayModes = Array.isArray(advertisedDisplayModes) ? supportedModes.filter((mode) => advertisedDisplayModes.includes(mode)) : void 0;
		const preferredDisplayMode = openaiUi?.preferredDisplayMode === "inline" || openaiUi?.preferredDisplayMode === "fullscreen" ? openaiUi.preferredDisplayMode : void 0;
		const displayModes = availableDisplayModes || preferredDisplayMode ? {
			availableDisplayModes: availableDisplayModes ?? [preferredDisplayMode],
			...preferredDisplayMode ? { preferredDisplayMode } : {}
		} : void 0;
		const requestedDisplayMode = params.displayMode ?? preferredDisplayMode ?? "inline";
		const csp = normalizeMcpAppCsp(uiMeta?.csp);
		const permissions = normalizePermissions(uiMeta?.permissions);
		const title = `${params.toolName} UI`;
		const viewId = params.viewId ?? `mcp-app-${randomUUID()}`;
		releaseRuntimeLease = params.runtime.acquireLease?.();
		deleteView(viewId);
		pruneViewStore(byteSize, true);
		const view = {
			viewId,
			runtime: params.runtime,
			agentId,
			sessionId: params.runtime.sessionId,
			serverName: params.serverName,
			toolName: params.toolName,
			uiResourceUri: params.uiResourceUri,
			...params.toolCallId ? { toolCallId: params.toolCallId } : {},
			html,
			...csp ? { csp } : {},
			...permissions ? { permissions } : {},
			...params.allowedAppToolNames ? { allowedAppToolNames: new Set(params.allowedAppToolNames) } : {},
			...params.prepareToolCall ? { prepareToolCall: params.prepareToolCall } : {},
			...params.uploadResources ? { uploadResources: params.uploadResources } : {},
			...params.authorizeAppInteraction ? { authorizeAppInteraction: params.authorizeAppInteraction } : {},
			...params.readOnly ? { readOnly: true } : {},
			requesterId: params.requesterId,
			...params.hostFile ? { hostFile: params.hostFile } : {},
			...params.richModelContextSupported !== void 0 ? { richModelContextSupported: params.richModelContextSupported } : {},
			...params.deepLink ? { deepLink: params.deepLink } : {},
			displayMode: availableDisplayModes?.length && !availableDisplayModes.includes(requestedDisplayMode) ? availableDisplayModes[0] : requestedDisplayMode,
			...displayModes ? { displayModes } : {},
			toolInput: params.toolInput,
			toolResult: params.toolResult,
			expiresAtMs: Date.now() + MCP_APP_VIEW_TTL_MS,
			requestWindowStartedAtMs: Date.now(),
			requestCount: 0,
			toolCallCount: 0,
			activeRequests: 0,
			byteSize,
			...releaseRuntimeLease ? { releaseRuntimeLease } : {}
		};
		releaseRuntimeLease = void 0;
		view.expiryTimer = setTimeout(() => {
			deleteView(view.viewId, view);
		}, MCP_APP_VIEW_TTL_MS);
		view.expiryTimer.unref?.();
		getViewStore().set(viewId, view);
		return {
			viewId,
			title,
			serverName: params.serverName,
			toolName: params.toolName,
			uiResourceUri: params.uiResourceUri,
			...params.toolCallId ? { toolCallId: params.toolCallId } : {}
		};
	} catch (error) {
		releaseRuntimeLease?.();
		getSessionMcpRequestSignal()?.throwIfAborted();
		logWarn(`mcp-app: failed to prepare ${params.uiResourceUri} from "${params.serverName}": ${formatErrorMessage(error)}`);
		return;
	}
}
function getMcpAppViewLease(viewId, runtime) {
	pruneViewStore();
	const view = getViewStore().get(viewId);
	return view?.runtime === runtime ? view : void 0;
}
function getMcpAppViewLeaseForSession(viewId, sessionKey, agentId) {
	pruneViewStore();
	const view = getViewStore().get(viewId);
	return view?.runtime.sessionKey === sessionKey && view.agentId === normalizeAgentId(agentId) ? view : void 0;
}
function acquireMcpAppViewRequest(view, kind, nowMs = Date.now()) {
	if (nowMs - view.requestWindowStartedAtMs >= 6e4) {
		view.requestWindowStartedAtMs = nowMs;
		view.requestCount = 0;
		view.toolCallCount = 0;
	}
	if (view.activeRequests >= 4) throw new Error("MCP App request concurrency limit reached");
	if (view.requestCount >= 120 || kind === "tool" && view.toolCallCount >= 30) throw new Error("MCP App request rate limit reached");
	view.requestCount += 1;
	if (kind === "tool") view.toolCallCount += 1;
	view.activeRequests += 1;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			view.activeRequests = Math.max(0, view.activeRequests - 1);
		}
	};
}
async function requireMcpAppInteraction(view) {
	if (view.readOnly === true || view.allowedAppToolNames === void 0) throw new Error("MCP App view is read-only");
	if (view.authorizeAppInteraction && !await view.authorizeAppInteraction()) throw new Error("MCP App widget grant is no longer active");
}
async function resolveMcpAppActiveView(params) {
	const requireRequester = (active) => {
		if (active.view.requesterId !== void 0 && active.view.requesterId !== params.requesterId) throw new McpAppViewExpiredError();
		active.runtime.assertOwnerCurrent?.();
		return active;
	};
	if (params.cfg && params.cfg.mcp?.apps?.enabled !== true) throw new Error("MCP App runtime is unavailable");
	const liveView = params.agentId ? getMcpAppViewLeaseForSession(params.viewId, params.sessionKey, params.agentId) : void 0;
	if (liveView) {
		if (liveView.runtime.mcpAppsEnabled !== true) throw new Error("MCP App runtime is unavailable");
		return requireRequester({
			runtime: liveView.runtime,
			view: liveView
		});
	}
	const existingRuntime = params.agentId && !parseAgentSessionKey(params.sessionKey) ? void 0 : peekSessionMcpRuntime({ sessionKey: params.sessionKey });
	if (existingRuntime && existingRuntime.mcpAppsEnabled !== true) throw new Error("MCP App runtime is unavailable");
	const existingView = existingRuntime ? getMcpAppViewLease(params.viewId, existingRuntime) : void 0;
	const restored = existingRuntime?.mcpAppsEnabled === true && existingView ? {
		runtime: existingRuntime,
		view: existingView
	} : params.cfg && params.restore !== false ? await restoreMcpAppView({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey,
		viewId: params.viewId
	}) : void 0;
	if (!restored) throw new McpAppViewExpiredError();
	return requireRequester(restored);
}
async function withMcpAppActiveView(active, kind, operation) {
	active.runtime.assertOwnerCurrent?.();
	active.runtime.markUsed();
	const release = acquireMcpAppViewRequest(active.view, kind);
	const releaseRuntimeLease = active.runtime.acquireLease?.();
	try {
		return await operation();
	} finally {
		release();
		releaseRuntimeLease?.();
		await completeDeferredSessionMcpRuntimeRetirement(active.runtime).catch((error) => {
			logWarn(`mcp-app: deferred runtime cleanup failed: ${formatErrorMessage(error)}`);
		});
	}
}
function requireString(params, key) {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
	return value.trim();
}
function resolveMcpAppSessionOwner(params, cfg) {
	const sessionKey = requireString(params, "sessionKey");
	const explicitAgentId = typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : void 0;
	const owner = resolveRequestedSessionAgentId(cfg, sessionKey, explicitAgentId);
	if (!owner.ok) throw new McpAppRequestError(owner.error);
	return owner.agentId;
}
function mcpAppHandler(operation) {
	return async (options) => {
		try {
			options.respond(true, await operation(options));
		} catch (error) {
			options.respond(false, void 0, error instanceof McpAppRequestError ? error.shape : errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error), error instanceof McpAppViewExpiredError ? { details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED } } : void 0));
		}
	};
}
const mcpAppHandlers = {"mcp.app.view": mcpAppHandler(async (options) => {
		const { params, context, client } = options;
		const sessionKey = requireString(params, "sessionKey");
		const agentId = resolveMcpAppSessionOwner(params, context.getRuntimeConfig());
		const requesterId = resolveMcpAppRequesterId(client);
		const read = retainSessionScopedRead(options, sessionKey, agentId);
		const assertRequestCurrent = () => {
			read?.assertCurrent();
			if (requesterId !== resolveMcpAppRequesterId(client)) throw new McpAppViewExpiredError();
		};
		try {
			const active = await resolveMcpAppActiveView({
				sessionKey: requireString(params, "sessionKey"),
				agentId: resolveMcpAppSessionOwner(params, context.getRuntimeConfig()),
				viewId: requireString(params, "viewId"),
				requesterId: resolveMcpAppRequesterId(client),
				cfg: context.getRuntimeConfig()
			});
			read?.assertCurrent();
			const payload = await withMcpAppActiveView(active, "read", async () => {
				const { view } = active;
				if (client?.connId) {
					const byConnection = modelContextSubscriptions.get(view) ?? /* @__PURE__ */ new Map();
					const previous = byConnection.get(client.connId);
					previous?.();
					if (previous) view.disposeCallbacks?.delete(previous);
					if (byConnection.size >= 32 && !byConnection.has(client.connId)) throw new Error("MCP App connection limit reached");
					const connId = client.connId;
					let updateId = getMcpAppModelContext(active.runtime, view)?.updateId;
					const unsubscribe = subscribeMcpAppModelContext(view, (state) => {
						const clearedUpdateId = updateId;
						updateId = state?.updateId;
						context.broadcastToConnIds("mcp.app.hostContextChanged", {
							viewId: view.viewId,
							...state === null ? {
								modelContext: null,
								updateId: clearedUpdateId
							} : {}
						}, /* @__PURE__ */ new Set([connId]));
					});
					const stop = () => {
						unsubscribe();
						client.connectionSignal?.removeEventListener("abort", stop);
						if (byConnection.get(connId) === stop) byConnection.delete(connId);
						view.disposeCallbacks?.delete(stop);
					};
					client.connectionSignal?.addEventListener("abort", stop, { once: true });
					byConnection.set(connId, stop);
					modelContextSubscriptions.set(view, byConnection);
					view.disposeCallbacks ??= /* @__PURE__ */ new Set();
					view.disposeCallbacks.add(stop);
					if (client.connectionSignal?.aborted) stop();
				}
				let interactive = false;
				try {
					await requireMcpAppInteraction(view);
					interactive = true;
				} catch {}
				const openFilesSupported = interactive && Boolean(active.runtime.sessionKey) && await canOpenMcpAppFiles(view);
				const updateModelContextSupported = interactive && Boolean(active.runtime.sessionKey) && active.runtime.mcpAppModelContextRevoked !== true;
				const sandboxPort = context.getMcpAppSandboxPort?.() ?? await context.ensureSandboxHostPort?.();
				if (sandboxPort === void 0) throw new Error("MCP App sandbox listener is unavailable; restart the Gateway");
				const configuredOrigin = context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
				let standalone = void 0;
				try {
					standalone = createMcpAppStandaloneTicket({
						sessionKey: requireString(params, "sessionKey"),
						view,
						toolOperationsAuthorized: authorizeOperatorScopesForMethod("mcp.app.callTool", client?.connect?.scopes ?? []).allowed
					});
				} catch (error) {
					logWarn(`mcp-app: standalone ticket unavailable: ${formatErrorMessage(error)}`);
				}
				assertRequestCurrent();
				return {
					sandboxUrl: buildMcpAppSandboxPath(view.csp),
					sandboxPort,
					...configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {},
					html: view.html,
					...view.csp ? { csp: view.csp } : {},
					toolInput: view.toolInput,
					toolResult: view.toolResult,
					hostContext: {
						"openai/modelContext": getMcpAppModelContext(active.runtime, view),
						...view.deepLink ? { "openai/deepLink": view.deepLink } : {}
					},
					...view.displayModes ? { displayModes: view.displayModes } : {},
					...view.displayMode ? { displayMode: view.displayMode } : {},
					richModelContextSupported: updateModelContextSupported && view.richModelContextSupported !== false,
					fileResourcesSupported: interactive && Boolean(view.hostFile),
					openFilesSupported,
					...standalone ? {
						standaloneUrl: standalone.url,
						standaloneExpiresAtMs: standalone.expiresAtMs
					} : {},
					messageSupported: interactive,
					updateModelContextSupported
				};
			});
			assertRequestCurrent();
			return payload;
		} finally {
			read?.release();
		}
	})};
