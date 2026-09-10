/**
 * Walks a Nest module graph's metadata and proves that every constructor parameter Nest has to
 * resolve by BARE CLASS TYPE actually has `design:paramtypes` behind it.
 *
 * This is the invariant a TypeScript runner without `emitDecoratorMetadata` breaks silently: with no
 * metadata a constructor looks dependency-free, Nest raises nothing, and the provider only fails when
 * it first touches the collaborator that arrived as `undefined`. Nothing here connects to anything —
 * only decorator metadata is read, so it runs offline in CI.
 */

const MODULE_KEYS = ["imports", "providers", "controllers", "exports"];

function unwrap(entry) {
	if (entry === null || entry === undefined) {
		return undefined;
	}
	// forwardRef(() => X)
	if (typeof entry === "object" && typeof entry.forwardRef === "function") {
		return entry.forwardRef();
	}
	// a DynamicModule: { module, imports, providers, ... }
	if (typeof entry === "object" && typeof entry.module === "function") {
		return entry;
	}
	return entry;
}

function classesOfProvider(entry) {
	if (typeof entry === "function") {
		return [entry];
	}
	if (typeof entry === "object" && entry !== null && "provide" in entry) {
		return typeof entry.useClass === "function" ? [entry.useClass] : [];
	}
	return [];
}

/** Every class Nest would have to construct, reached from `roots` (one root module or several). */
export function collectInjectableClasses(roots) {
	const seenModules = new Set();
	const classes = new Set();
	const queue = Array.isArray(roots) ? [...roots] : [roots];

	while (queue.length > 0) {
		const raw = unwrap(queue.pop());
		if (raw === undefined) {
			continue;
		}
		const moduleClass = typeof raw === "object" && raw.module ? raw.module : raw;
		if (typeof moduleClass !== "function" || seenModules.has(moduleClass)) {
			continue;
		}
		seenModules.add(moduleClass);

		for (const key of MODULE_KEYS) {
			const declared = Reflect.getMetadata(key, moduleClass) ?? [];
			const dynamic = typeof raw === "object" && Array.isArray(raw[key]) ? raw[key] : [];
			for (const entry of [...declared, ...dynamic]) {
				const resolved = unwrap(entry);
				if (resolved === undefined) {
					continue;
				}
				if (key === "imports") {
					queue.push(resolved);
					continue;
				}
				for (const cls of classesOfProvider(resolved)) {
					// An imported module re-exported by `exports` is a module, not a provider.
					if (Reflect.hasMetadata("imports", cls) || Reflect.hasMetadata("providers", cls)) {
						queue.push(cls);
					} else {
						classes.add(cls);
					}
				}
			}
		}
	}

	return { classes: [...classes], moduleCount: seenModules.size };
}

/** Returns the human-readable failures; empty means the graph is resolvable by type. */
export function findUnresolvableParameters(classes) {
	const failures = [];

	for (const cls of classes) {
		// A parameter carrying an explicit `@Inject(token)` needs no type metadata, and one marked
		// `@Optional()` is allowed to arrive undefined by design.
		const explicit = new Set([
			...(Reflect.getMetadata("self:paramtypes", cls) ?? []).map((dep) => dep.index),
			...(Reflect.getMetadata("optional:paramtypes", cls) ?? []),
		]);
		const paramtypes = Reflect.getMetadata("design:paramtypes", cls);

		if (paramtypes === undefined) {
			// No metadata at all. Only a constructor whose every parameter carries an explicit
			// `@Inject(token)` can still be resolved.
			for (let index = 0; index < cls.length; index += 1) {
				if (!explicit.has(index)) {
					failures.push(`${cls.name}: parameter ${index} has no design:paramtypes and no @Inject`);
				}
			}
			continue;
		}

		paramtypes.forEach((type, index) => {
			if (!explicit.has(index) && (type === undefined || type === Object)) {
				failures.push(
					`${cls.name}: parameter ${index} resolved to ${type === Object ? "Object" : "undefined"}`,
				);
			}
		});
	}

	return failures;
}

/**
 * `Object` is what a parameter typed as an interface, a union or a circular import compiles to, and
 * plenty of those are legitimate (they always carry an `@Inject`). Only the ones that do not are
 * reported above, so a clean run means: every bare-class injection has a real class behind it.
 */
export function assertResolvableModuleGraph(roots, label) {
	const { classes, moduleCount } = collectInjectableClasses(roots);
	const failures = findUnresolvableParameters(classes);

	if (failures.length > 0) {
		console.error(
			`${label}: ${failures.length} constructor parameter(s) Nest cannot resolve — the runner is not emitting decorator metadata:`,
		);
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		process.exitCode = 1;
		return;
	}

	console.log(
		`${label}: ${classes.length} injectable classes across ${moduleCount} modules; every bare-class constructor parameter has design:paramtypes.`,
	);
}
