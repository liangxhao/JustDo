function copyRecoverySource({ rootDir, sourceRoot, capturedRoot, boundaryRoot, sources, native: suppliedNative }) {
	let native = suppliedNative;
	let recovery;
	try {
		recovery = createPluginSourceCapture();
		const directory = recovery.directory;
		const relocate = (filename) => path.join(directory, path.relative(boundaryRoot, filename));
		const hardlinkedTargets = /* @__PURE__ */ new Map();
		fs.cpSync(boundaryRoot, recovery.directory, {
			recursive: true,
			verbatimSymlinks: true,
			filter: (from, to) => {
				const fact = native?.references.get(from);
				if (!fact) {
					if (fs.lstatSync(from).isSymbolicLink()) {
						const target = fs.readlinkSync(from);
						const relative = path.isAbsolute(target) ? relativePluginPathInsideRootSync(boundaryRoot, target) : void 0;
						if (relative !== void 0) {
							fs.mkdirSync(path.dirname(to), {
								recursive: true,
								mode: 448
							});
							fs.symlinkSync(path.relative(path.dirname(to), path.join(directory, relative)), to, fs.statSync(from).isDirectory() ? "junction" : "file");
							return false;
						}
					}
					return true;
				}
				const retained = {
					...fact,
					sourceIdentity: fact.capturedIdentity
				};
				if (linkPluginNativeReference(fact.capturedPath, to, retained) === "hardlink") hardlinkedTargets.set(to, retained);
				native.references.set(from, retained);
				return false;
			}
		});
		const assertReference = createPluginNativeReferenceValidator(recovery.directory, rootDir);
		for (const [target, fact] of hardlinkedTargets) assertReference(target, fact, native.namespaces.get(fact.namespace));
		for (const captured of new Set(sources.values())) fs.lstatSync(relocate(captured));
		const copiedSources = new Map(Array.from(sources, ([source, captured]) => [source, relocate(captured)]));
		const previousNative = native;
		native = previousNative?.fork(relocate);
		previousNative?.dispose();
		const sourceCapture = recovery;
		const root = relocate(capturedRoot);
		let disposed = false;
		return {
			rootDir: root,
			sourceCapture,
			resolve: createRecoverySourceResolver(rootDir, sourceRoot, copiedSources),
			native,
			fork() {
				if (disposed) throw new Error("Plugin source recovery has been disposed");
				for (const captured of new Set(copiedSources.values())) sourceCapture.assertModuleAvailable(captured);
				return copyRecoverySource({
					rootDir,
					sourceRoot,
					capturedRoot: root,
					boundaryRoot: directory,
					sources: copiedSources,
					native: native?.fork()
				});
			},
			dispose() {
				if (!disposed) {
					disposed = true;
					try {
						sourceCapture.dispose();
					} finally {
						native?.dispose();
					}
				}
			},
			async disposeAsync() {
				if (!disposed) {
					disposed = true;
					await Promise.all([sourceCapture.disposeAsync(), native?.disposeAsync()]);
				}
			}
		};
	} catch (error) {
		try {
			recovery?.dispose();
		} finally {
			native?.dispose();
		}
		if (hasErrnoCode(error, "ENOENT")) throw new PluginSourceRecoveryUnavailableError(error);
		throw error;
	}
}
