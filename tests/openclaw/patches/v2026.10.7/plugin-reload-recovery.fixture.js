function createPluginReloadRecovery(previousRegistry, preparePlugins) {
	const moduleRecoveries = /* @__PURE__ */ new Map();
	const previouslyUnavailableIds = new Set(previousRegistry.plugins.filter((record) => record.status === "error" || getPluginInstance(record)?.disposing).map((record) => record.id));
	const selectedUnavailableIds = /* @__PURE__ */ new Set();
	const previousHookIds = /* @__PURE__ */ new Set();
	return {
		get previousHookIds() {
			return previousHookIds;
		},
		get unavailablePluginIds() {
			return new Set([...selectedUnavailableIds].filter((id) => !previouslyUnavailableIds.has(id)));
		},
		capture(pluginIds) {
			const warnings = [];
			for (const record of previousRegistry.plugins) {
				if (!pluginIds.has(record.id)) continue;
				if (previouslyUnavailableIds.has(record.id)) {
					selectedUnavailableIds.add(record.id);
					continue;
				}
				previousHookIds.add(record.id);
				try {
					const recovery = capturePluginRuntimeRecovery(record);
					if (recovery) moduleRecoveries.set(record.id, recovery);
				} catch (error) {
					if (!(error instanceof PluginSourceRecoveryUnavailableError)) throw error;
					selectedUnavailableIds.add(record.id);
					warnings.push(`Plugin ${record.id} captured source is missing. Continuing replacement; rollback cannot restore this plugin's previous code.`);
				}
			}
			return warnings;
		},
		prepare(params, cause) {
			const retainedErrorIds = new Set(previousRegistry.plugins.filter((record) => selectedUnavailableIds.has(record.id) && record.status === "error").map((record) => record.id));
			const recoveryParams = {
				...params,
				pluginIds: previousRegistry.plugins.filter((record) => !selectedUnavailableIds.has(record.id) || retainedErrorIds.has(record.id)).map((record) => record.id),
				replacePluginIds: new Set([...params.replacePluginIds ?? []].filter((id) => !retainedErrorIds.has(id))),
				moduleRecoveries
			};
			if (selectedUnavailableIds.size) {
				const plan = preparePlugins({
					...recoveryParams,
					loadModules: false
				});
				plan.retireGatewayRuntimeBindings();
				const unavailable = plan.pluginRegistry.plugins.filter((record) => selectedUnavailableIds.has(record.id) && record.enabled && record.status === "loaded");
				if (unavailable.length) throw new Error(`Plugin recovery requires previously retired runtimes without captured source: ${unavailable.map((record) => record.id).join(", ")}`, { cause });
			}
			return preparePlugins(recoveryParams);
		},
		dispose() {
			for (const recovery of moduleRecoveries.values()) recovery.module.dispose();
			moduleRecoveries.clear();
		}
	};
}
