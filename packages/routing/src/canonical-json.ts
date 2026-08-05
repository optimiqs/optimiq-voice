/**
 * Canonical JSON — a byte-stable serialization of plain data.
 *
 * `JSON.stringify` preserves insertion order of object keys, so two snapshots that differ only in
 * the order a loader happened to build its objects would hash differently and invalidate a cache
 * for no reason. Canonical form sorts keys, drops `undefined` (which is what an absent optional
 * column means) and normalises `null`, so the hash is a function of the *content*.
 *
 * The rules, in full:
 *
 * - objects: keys sorted by UTF-16 code unit (`Array.prototype.sort` default), `undefined` values
 *   omitted entirely;
 * - arrays: order preserved — array order is meaningful everywhere in this domain (route priority,
 *   trunk failover, IVR options), so sorting them would destroy information;
 * - numbers: must be finite; `NaN` / `±Infinity` throw rather than becoming `null`;
 * - strings, booleans, `null`: as JSON;
 * - anything else (functions, symbols, `Date`, `Map`, class instances) throws.
 *
 * That last rule is the load-bearing one. The artifact is cached as JSON in a NATS KV bucket, so
 * anything that does not survive a `JSON.parse(JSON.stringify(x))` round trip must never reach it.
 * Throwing here is how that is enforced rather than documented.
 */

import { RoutingSnapshotError } from "./errors";

/** The plain-data subset this package serializes. */
export type CanonicalValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue | undefined };

/** Serializes `value` to canonical JSON. Throws on anything that is not plain, finite data. */
export function canonicalJson(value: unknown): string {
	return write(value, "$");
}

function write(value: unknown, path: string): string {
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "boolean": {
			return value ? "true" : "false";
		}
		case "number": {
			if (!Number.isFinite(value)) {
				throw new RoutingSnapshotError(path, `${String(value)} is not serializable`);
			}
			// `-0` and `0` are the same value to every consumer here; normalising avoids a hash flip.
			return JSON.stringify(value === 0 ? 0 : value);
		}
		case "string": {
			return JSON.stringify(value);
		}
		case "object": {
			return Array.isArray(value)
				? writeArray(value as readonly unknown[], path)
				: writeObject(value as Record<string, unknown>, path);
		}
		default: {
			throw new RoutingSnapshotError(path, `values of type "${typeof value}" are not serializable`);
		}
	}
}

function writeArray(value: readonly unknown[], path: string): string {
	const parts: string[] = [];
	for (const [index, entry] of value.entries()) {
		// `undefined` inside an array is `null` in JSON; making it explicit keeps the round trip
		// honest instead of depending on `JSON.stringify`'s quiet substitution.
		parts.push(entry === undefined ? "null" : write(entry, `${path}[${index}]`));
	}
	return `[${parts.join(",")}]`;
}

function writeObject(value: Record<string, unknown>, path: string): string {
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) {
		throw new RoutingSnapshotError(
			path,
			"only plain objects are serializable; the artifact must survive a JSON round trip",
		);
	}
	const parts: string[] = [];
	for (const key of Object.keys(value).sort()) {
		const entry = value[key];
		if (entry === undefined) {
			continue;
		}
		parts.push(`${JSON.stringify(key)}:${write(entry, `${path}.${key}`)}`);
	}
	return `{${parts.join(",")}}`;
}

/**
 * Deep structural equality over canonical form.
 *
 * Used by the determinism tests and by callers who want to know whether a recompile actually
 * changed anything before they write to the cache.
 */
export function canonicalEquals(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}
