async function reloadGatewayPlugins({ runtime, port, log, loadGatewayPluginBootstrapModule, prepareAttachedPluginRuntime }, params) {
	const restartDrainSignal = getGatewayRestartDrainSignal();
	const drainSignal = params.pluginLifecycle?.waitForDrain && params.pluginLifecycle.drainSignal ? AbortSignal.any([restartDrainSignal, params.pluginLifecycle.drainSignal]) : restartDrainSignal;
	const { prepareGatewayPluginLoad: preparePlugins } = await loadGatewayPluginBootstrapModule();
	const { pluginRuntime, kernel, pluginWorkspaceDir, runtimeState, ambientEnvTriggers, workerEnvironmentStartup, coreGatewayMethodNames, pluginHostServices, baseMethods, resolvePluginGatewayContext, channelManager, clients, broadcast } = runtime;
	const previousRegistry = pluginRuntime.registry;
	const previousConfig = getRuntimeConfig();
	const previousServices = kernel.pluginRuntimeGeneration.currentServices();
	const previousMetadata = runtime.pluginMetadataSnapshot;
	const previousLoadContext = getPluginRuntimeLoadContext(previousRegistry);
	const recovery = createPluginReloadRecovery(previousRegistry, preparePlugins);
	}
