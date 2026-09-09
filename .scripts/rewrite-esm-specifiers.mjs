import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tsc` with `module: "preserve"` emits relative specifiers verbatim, which Node's ESM
 * resolver rejects. This rewrites emitted relative specifiers to explicit runtime paths.
 */

const relativeModuleSpecifierPattern =
	/(\bfrom\s*["']|\bimport\s*["']|\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/gu;
const runtimeExtensionPattern = /\.(?:c?js|mjs|json|node|wasm)$/iu;

export async function rewriteEsmSpecifiers(distDir) {
	if (!existsSync(distDir)) {
		return;
	}

	// A specifier that resolves to nothing on disk used to get `.js` appended anyway and the script
	// reported success — so the build stayed green and the container threw ERR_MODULE_NOT_FOUND at
	// first import, naming a path that never existed. Converting a `module: "preserve"` emit into
	// runnable ESM is the whole job of this script, and a specifier it cannot resolve is precisely
	// the case worth failing on. Collected rather than thrown at the first one: the useful message
	// is the whole list.
	const unresolved = [];

	for (const filePath of await listEmittedModules(distDir)) {
		const source = await readFile(filePath, "utf8");
		const fileDir = path.dirname(filePath);
		const rewritten = source.replace(
			relativeModuleSpecifierPattern,
			(match, prefix, specifier, suffix) => {
				if (runtimeExtensionPattern.test(specifier)) {
					return match;
				}
				const resolved = path.resolve(fileDir, specifier);
				// `.d.ts` counts as resolved: a declaration file importing a types-only module has no
				// emitted `.js` beside it, and rewriting it to `.js` is still what the type resolver
				// wants.
				if (existsSync(`${resolved}.js`) || existsSync(`${resolved}.d.ts`)) {
					return `${prefix}${specifier}.js${suffix}`;
				}
				if (
					existsSync(path.join(resolved, "index.js")) ||
					existsSync(path.join(resolved, "index.d.ts"))
				) {
					return `${prefix}${specifier}/index.js${suffix}`;
				}
				unresolved.push(`${filePath}: ${specifier}`);
				return match;
			},
		);
		if (rewritten !== source) {
			await writeFile(filePath, rewritten, "utf8");
		}
	}

	if (unresolved.length > 0) {
		throw new Error(
			`rewrite-esm-specifiers: ${unresolved.length} specifier(s) resolve to no emitted module:\n  ${unresolved.join("\n  ")}`,
		);
	}
}

async function listEmittedModules(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				return await listEmittedModules(entryPath);
			}
			return entry.name.endsWith(".js") || entry.name.endsWith(".d.ts") ? [entryPath] : [];
		}),
	);
	return nested.flat();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await rewriteEsmSpecifiers(path.join(process.cwd(), "dist"));
}
