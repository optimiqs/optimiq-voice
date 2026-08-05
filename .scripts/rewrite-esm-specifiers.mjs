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
				if (existsSync(`${resolved}.js`)) {
					return `${prefix}${specifier}.js${suffix}`;
				}
				if (existsSync(path.join(resolved, "index.js"))) {
					return `${prefix}${specifier}/index.js${suffix}`;
				}
				return `${prefix}${specifier}.js${suffix}`;
			},
		);
		if (rewritten !== source) {
			await writeFile(filePath, rewritten, "utf8");
		}
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
