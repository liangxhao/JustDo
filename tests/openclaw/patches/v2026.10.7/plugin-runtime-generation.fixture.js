function createGatewayPluginRuntimeGeneration(params) {
	let current;
	let latestReservation;
	let reloadStatus;
	let pending;
	const createClaim = () => {
		const claim = Object.freeze({
			isCurrent: () => current === claim && pending === void 0,
			waitForUnblocked: async () => {
				for (;;) {
					const reservation = pending;
					if (current !== claim || !reservation) return claim.isCurrent();
					await reservation.settled.promise;
				}
			},
			publish: (publication) => {
				if (!claim.isCurrent()) return false;
				publication();
				return true;
			}
		});
		return claim;
	};
	current = createClaim();
	return {
		getReloadStatus: () => reloadStatus,
		currentClaim: () => current,
		currentServices: () => params.getServices(),
		publishServices: (claim, services) => claim.publish(() => params.setServices(services)),
		reserve: () => {
			if (pending) throw new Error("a Gateway plugin runtime replacement is already pending");
			const reservation = {
				claim: createClaim(),
				settled: createDeferredCore()
			};
			const previousReloadStatus = reloadStatus;
			latestReservation = reservation.claim;
			pending = reservation;
			const settle = (accepted) => {
				if (pending !== reservation) return;
				if (accepted) current = reservation.claim;
				pending = void 0;
				reservation.settled.resolve();
			};
			return Object.freeze({
				claim: reservation.claim,
				commit: () => settle(true),
				reject: () => settle(false),
				setReloadStatus: (status) => {
					if (latestReservation === reservation.claim) reloadStatus = status;
				},
				finishReload: (outcome, pluginIds, registry, unavailablePluginIds, reportFailure) => {
					if (latestReservation !== reservation.claim) return;
					if (outcome === "unchanged") {
						reloadStatus = previousReloadStatus;
						return;
					}
					const restoredIds = outcome === "restored" ? new Set(registry.plugins.filter((record) => record.status === "loaded" && (record.format === "bundle" || getPluginInstance(record)?.acceptingCalls)).map((record) => record.id)) : pluginIds;
					const failedIds = new Set(previousReloadStatus?.phase === "failed" ? previousReloadStatus.pluginIds.filter((id) => !pluginIds.has(id) || !restoredIds.has(id)) : []);
					for (const id of pluginIds) if (outcome === "failed" || outcome === "restored" && unavailablePluginIds.has(id) && !restoredIds.has(id)) failedIds.add(id);
					reloadStatus = failedIds.size ? {
						phase: "failed",
						pluginIds: [...failedIds].toSorted(),
						reason: "Plugin activation or recovery failed. Retry openclaw plugins reload <id> after admitted work settles, or restart the Gateway. Inspect the Gateway log for the failure."
					} : void 0;
					if (outcome === "failed" && reloadStatus?.reason) reportFailure?.(reloadStatus.reason);
				}
			});
		}
	};
}
