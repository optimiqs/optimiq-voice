#!/usr/bin/env node
/**
 * Fails when `config/nats.conf` does not grant a service the JetStream subjects its own code needs.
 *
 * ## Why a script and not a test
 *
 * The broker's permission model is enforced at RUNTIME and it fails QUIETLY: a publish the account
 * does not allow is answered with a `Permissions Violation` on the connection's error channel, not
 * with a rejected promise the caller sees. A pack that adds a stream, a KV bucket or a durable
 * consumer and forgets the matching grant therefore ships something that boots, logs "applied
 * JetStream definitions", and then does not work — and the only evidence is a line in the broker's
 * own log that nobody is reading. That has happened repeatedly on this tree (`SECURITY` and
 * `MESSAGING` both landed without grants), which is what this check exists to stop.
 *
 * ## What it asserts
 *
 * Three things, all derived from the code rather than from a hand-kept list:
 *
 * 1. Every stream a service ENSURES has `$JS.API.STREAM.{INFO,CREATE,UPDATE}.<stream>` on that
 *    service's publish allow-list. Those are exactly the three requests `ensureStreams` makes.
 * 2. Every KV bucket a service ensures has the same three on `KV_<bucket>`, because a bucket IS a
 *    stream to the JetStream API and `ensureKvBuckets` reaches it the same way.
 * 3. Every durable consumer name the service's source declares has
 *    `$JS.API.CONSUMER.{CREATE,INFO,MSG.NEXT}.<stream>.<durable>` — add it, read its backlog for
 *    the metrics gauges, and pull from it.
 *
 * A grant may be broader than what is required (`…CREATE.CALLS.>` covers every consumer on
 * `CALLS`); the check is coverage, not equality, and it uses real NATS wildcard semantics so a
 * `>`-terminated grant satisfies everything beneath it.
 *
 * The catalogue comes from `@optimiq-voice/events` — its built output when it exists, its source
 * under a TypeScript loader otherwise — so a stream added to `EVENT_STREAMS` is picked up with no
 * change here.
 *
 * Usage: `node .scripts/check-nats-grants.mjs [--conf config/nats.conf]`
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which nats.conf identity ensures what, and where its code lives.
 *
 * The two flags named here are the ones that decide whether the ensure runs at all
 * (`PBX_ENSURE_STREAMS`, `ENGINE_ENSURE_STREAMS`); a deployment that turns them off applies the
 * definitions from a migration job instead, and still needs the grants for everything else on this
 * list, so they do not gate the check.
 */
const SERVICES = [
	{ id: "api", user: "$NATS_API_USER", sourceRoot: "apps/api/src", flag: "PBX_ENSURE_STREAMS" },
	{
		id: "engine",
		user: "$NATS_ENGINE_USER",
		sourceRoot: "apps/engine/src",
		flag: "ENGINE_ENSURE_STREAMS",
	},
];

// -------------------------------------------------------------------------------------------
// The catalogue
// -------------------------------------------------------------------------------------------

async function loadCatalogue() {
	const built = join(ROOT, "packages/events/dist/streams.js");
	const source = join(ROOT, "packages/events/src/streams.ts");
	if (exists(built)) {
		return await import(pathToFileURL(built).href);
	}
	// No dist yet (a fresh clone, or a CI job that checks before it builds). `tsx` is a devDependency
	// of this workspace and registering it lets the same module be read straight from source.
	const { register } = await import("node:module");
	register("tsx/esm", pathToFileURL(join(ROOT, "node_modules/")).href);
	return await import(pathToFileURL(source).href);
}

function exists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

// -------------------------------------------------------------------------------------------
// nats.conf — the publish allow-lists, per user
// -------------------------------------------------------------------------------------------

/**
 * Returns `{ "$NATS_API_USER": ["subject", …], … }`.
 *
 * A deliberately small reader rather than a HOCON parser: the file's user blocks are uniform
 * (`user: $NATS_X_USER` … `publish: { allow: [ "…" ] }`), comments are line comments, and every
 * subject is a quoted string on its own line. Anything that stops matching that shape shows up as a
 * user with no grants, which fails loudly rather than passing silently.
 */
function parsePublishAllows(conf) {
	const lines = conf.split("\n");
	const allows = new Map();
	let user = null;
	let inPublish = false;
	let inAllow = false;

	for (const raw of lines) {
		const line = raw.replace(/#.*$/, "").trim();
		if (line.length === 0) {
			continue;
		}
		const userMatch = /^user:\s*(\$[A-Z_]+)\s*$/.exec(line);
		if (userMatch !== null) {
			user = userMatch[1];
			allows.set(user, allows.get(user) ?? []);
			inPublish = false;
			inAllow = false;
			continue;
		}
		if (user === null) {
			continue;
		}
		if (/^publish:\s*\{/.test(line)) {
			inPublish = true;
			continue;
		}
		if (/^subscribe:\s*\{/.test(line)) {
			inPublish = false;
			inAllow = false;
			continue;
		}
		if (inPublish && /^allow:\s*\[/.test(line)) {
			inAllow = true;
			continue;
		}
		if (inAllow) {
			if (line.startsWith("]")) {
				inAllow = false;
				inPublish = false;
				continue;
			}
			const subject = /^"([^"]+)"/.exec(line);
			if (subject !== null) {
				allows.get(user).push(subject[1]);
			}
		}
	}
	return allows;
}

/** NATS subject matching: `*` is exactly one token, `>` is one or more and must be last. */
function grantCovers(grant, subject) {
	const g = grant.split(".");
	const s = subject.split(".");
	for (let index = 0; index < g.length; index += 1) {
		if (g[index] === ">") {
			return s.length > index;
		}
		if (index >= s.length) {
			return false;
		}
		if (g[index] !== "*" && g[index] !== s[index]) {
			return false;
		}
	}
	return g.length === s.length;
}

// -------------------------------------------------------------------------------------------
// The code — what each service ensures, and which durables it declares
// -------------------------------------------------------------------------------------------

function sourceFiles(root) {
	const out = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist") {
					walk(path);
				}
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
				out.push(path);
			}
		}
	};
	walk(root);
	return out;
}

/**
 * The streams and buckets a service applies definitions for.
 *
 * `ensureStreams(manager)` with no second argument means the WHOLE catalogue — that is the engine's
 * boot path — so an absent list widens rather than narrows. `ensureStreams(manager, [X_STREAM])` is
 * read by resolving each identifier against the catalogue module's exports, which is why a renamed
 * or removed definition surfaces here as an error instead of as a silently skipped assertion.
 */
function ensuredAssets(files, catalogue) {
	const streams = new Set();
	const buckets = new Set();
	const problems = [];

	const resolveNames = (target, identifiers, file) => {
		for (const identifier of identifiers) {
			const definition = catalogue[identifier];
			if (definition === undefined || typeof definition.name !== "string") {
				problems.push(`${file}: ${identifier} is not an exported definition of @optimiq-voice/events`);
				continue;
			}
			target.add(definition.name);
		}
	};

	for (const file of files) {
		const text = readFileSync(file, "utf8");
		for (const [fn, target, all] of [
			["ensureStreams", streams, catalogue.EVENT_STREAMS],
			["ensureKvBuckets", buckets, catalogue.KV_BUCKETS],
		]) {
			const call = new RegExp(`\\b${fn}\\(\\s*\\w+\\s*(,\\s*\\[([\\s\\S]*?)\\])?\\s*\\)`, "g");
			for (const match of text.matchAll(call)) {
				if (match[2] === undefined) {
					for (const definition of all) {
						target.add(definition.name);
					}
					continue;
				}
				resolveNames(
					target,
					match[2].split(",").map((part) => part.trim()).filter((part) => /^[A-Z][A-Z0-9_]*$/.test(part)),
					file,
				);
			}
		}
	}
	return { streams, buckets, problems };
}

/**
 * Durable consumer names, paired with the stream they are added on.
 *
 * Two shapes, because the tree has two:
 *
 * - an object literal carrying both (`{ stream: "CALLS", durable: "pbx-webhook-calls" }`), read as
 *   a pair;
 * - a module-level `const DURABLE = "…"` in a file that names exactly ONE `*_STREAM` from the
 *   catalogue, which is every consumer service here. A file naming several is reported rather than
 *   guessed at — a wrong pairing would assert the wrong subject and pass.
 */
function durableConsumers(files, catalogue) {
	const pairs = [];
	const problems = [];

	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const paired = new Set();
		for (const match of text.matchAll(
			/stream:\s*"([A-Z][A-Z0-9_]*)"[\s\S]{0,400}?durable:\s*"([\w-]+)"/g,
		)) {
			pairs.push({ stream: match[1], durable: match[2], file });
			paired.add(match[2]);
		}

		const loose = [
			...text.matchAll(/^\s*(?:export\s+)?const\s+[A-Z_]*DURABLE\s*=\s*"([\w-]+)"/gm),
		].map((match) => match[1]);
		const unpaired = loose.filter((durable) => !paired.has(durable));
		if (unpaired.length === 0) {
			continue;
		}
		const referenced = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9_]*_STREAM)\b/g)].map((m) => m[1]))]
			.map((identifier) => catalogue[identifier]?.name)
			.filter((name) => typeof name === "string");
		if (referenced.length !== 1) {
			problems.push(
				`${file}: declares durable(s) ${unpaired.join(", ")} but names ${referenced.length} streams — ` +
					`pair them explicitly (\`stream: "NAME", durable: "…"\`) so this check can assert them`,
			);
			continue;
		}
		for (const durable of unpaired) {
			pairs.push({ stream: referenced[0], durable, file });
		}
	}
	return { pairs, problems };
}

// -------------------------------------------------------------------------------------------
// The assertion
// -------------------------------------------------------------------------------------------

function requiredSubjects(streams, buckets, consumers) {
	const subjects = [];
	const streamOps = ["INFO", "CREATE", "UPDATE"];
	for (const stream of [...streams].sort()) {
		for (const op of streamOps) {
			subjects.push({ subject: `$JS.API.STREAM.${op}.${stream}`, because: `stream ${stream}` });
		}
	}
	for (const bucket of [...buckets].sort()) {
		for (const op of streamOps) {
			subjects.push({
				subject: `$JS.API.STREAM.${op}.KV_${bucket}`,
				because: `KV bucket ${bucket}`,
			});
		}
	}
	for (const { stream, durable, file } of consumers) {
		for (const op of ["CREATE", "INFO", "MSG.NEXT"]) {
			subjects.push({
				subject: `$JS.API.CONSUMER.${op}.${stream}.${durable}`,
				because: `durable ${durable} on ${stream} (${file})`,
			});
		}
	}
	return subjects;
}

async function main() {
	const confArgument = process.argv.indexOf("--conf");
	const confPath =
		confArgument === -1 ? join(ROOT, "config/nats.conf") : resolve(process.argv[confArgument + 1]);
	const catalogue = await loadCatalogue();
	const allows = parsePublishAllows(readFileSync(confPath, "utf8"));

	const failures = [];
	const problems = [];
	let checked = 0;

	for (const service of SERVICES) {
		const files = sourceFiles(join(ROOT, service.sourceRoot));
		const assets = ensuredAssets(files, catalogue);
		const consumers = durableConsumers(files, catalogue);
		problems.push(...assets.problems, ...consumers.problems);

		const granted = allows.get(service.user);
		if (granted === undefined || granted.length === 0) {
			problems.push(`${confPath}: no publish allow-list found for ${service.user}`);
			continue;
		}

		const missing = [];
		for (const { subject, because } of requiredSubjects(
			assets.streams,
			assets.buckets,
			consumers.pairs,
		)) {
			checked += 1;
			if (!granted.some((grant) => grantCovers(grant, subject))) {
				missing.push({ subject, because });
			}
		}
		if (missing.length > 0) {
			failures.push({ service, missing });
		}
		console.log(
			`${service.id} (${service.user}): ${assets.streams.size} streams, ${assets.buckets.size} buckets, ` +
				`${consumers.pairs.length} durable consumers, ${granted.length} publish grants`,
		);
	}

	if (problems.length > 0) {
		console.error("\nCould not derive the requirement:\n");
		for (const problem of problems) {
			console.error(`  ${problem}`);
		}
	}

	if (failures.length > 0) {
		console.error("\nconfig/nats.conf is missing JetStream grants.\n");
		for (const { service, missing } of failures) {
			console.error(`  ${service.user} (${service.id}) — add to its publish allow list:\n`);
			for (const { subject, because } of missing) {
				console.error(`      "${subject}"    # ${because}`);
			}
			console.error("");
		}
	}

	if (failures.length > 0 || problems.length > 0) {
		process.exitCode = 1;
		return;
	}
	console.log(`\nOK — ${checked} required JetStream subjects are all granted.`);
}

await main();
