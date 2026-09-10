/** Types for `check-di-metadata.mjs`, which the two apps' `check:di` entry points import. */

/** A Nest module or provider class; only ever handled as an opaque constructor here. */
type Constructor = new (...args: never[]) => unknown;

export function collectInjectableClasses(roots: Constructor | readonly Constructor[]): {
	classes: Constructor[];
	moduleCount: number;
};

export function findUnresolvableParameters(classes: readonly Constructor[]): string[];

/** Prints the verdict and sets a non-zero `process.exitCode` when anything is unresolvable. */
export function assertResolvableModuleGraph(
	roots: Constructor | readonly Constructor[],
	label: string,
): void;
