import { startTestSmtp } from "./fixtures/smtp-test-server.mjs";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Fresh database volumes and an isolated Docker network. Uses locally built audit images.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(root, "apps/api/package.json"));
const postgres = require("postgres");
const prefix = `voice-stack-${process.pid}`;
const password = `test-${randomBytes(24).toString("hex")}`;
const containers = [];
const scratch = mkdtempSync(resolve(tmpdir(), "voice-platform-"));
const objects = resolve(scratch, "objects");
mkdirSync(objects); chmodSync(objects, 0o777);
const mediaIP = process.env.BROWSER_MEDIA_IP;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let database;
let smtp;
let browser;
let page;
const run = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function until(check, label, ms = 60000) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try { if (await check()) return; } catch (error) { last = error; }
		await delay(250);
	}
	throw Error(`Timed out: ${label}${last ? ` (${String(last).replaceAll(password, "[test-secret]")})` : ""}`);
}
function start(name, image, env, options = [], command = []) {
	const id = `${prefix}-${name}`;
	run(["run", "-d", "--name", id, "--network", prefix, "--network-alias", name,
		...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), ...options, image, ...command]);
	containers.push(id);
	return id;
}
async function port(id, target) {
	let result;
	await until(() => { result = run(["port", id, `${target}/tcp`]).split(":").at(-1); return Number(result) > 0; }, "published port");
	return result;
}
async function installAudio(context) {
	await context.addInitScript(() => {
		window.testConnections = [];
		const Native = window.RTCPeerConnection;
		window.RTCPeerConnection = class extends Native { constructor(config) { super(config); window.testConnections.push(this); } };
		navigator.mediaDevices.getUserMedia = async () => {
			const audio = new AudioContext(); await audio.resume();
			const oscillator = audio.createOscillator(), output = audio.createMediaStreamDestination();
			oscillator.frequency.value = 660; oscillator.connect(output); oscillator.start();
			output.stream.getAudioTracks()[0].addEventListener("ended", () => { oscillator.stop(); void audio.close(); });
			return output.stream;
		};
	});
}
async function freePort() {
	const server = createServer();
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}
try {
	smtp = await startTestSmtp();
	run(["network", "create", prefix]);
	const pg = start("postgres", "postgres:16.10-alpine3.22", { POSTGRES_PASSWORD: password }, ["-p", "127.0.0.1::5432"]);
	const pgPort = await port(pg, 5432);
	database = postgres(`postgresql://postgres:${password}@127.0.0.1:${pgPort}/postgres`, { max: 1, connect_timeout: 2 });
	await until(async () => { await database`select 1`; return true; }, "Postgres startup");
	for (const name of ["optimiq_voice", "optimiq_pbx", "optimiq_cdr"]) await database.unsafe(`create database ${name}`);
	const url = (name, host = `127.0.0.1:${pgPort}`) => `postgresql://postgres:${password}@${host}/${name}`;
	const databases = host => ({ API_DATABASE_URL: url("optimiq_voice", host), DATABASE_MIGRATION_URL: url("optimiq_voice", host),
		PBX_DATABASE_URL: url("optimiq_pbx", host), CDR_DATABASE_URL: url("optimiq_cdr", host),
		PBX_DATABASE_MIGRATION_URL: url("optimiq_pbx", host), CDR_DATABASE_MIGRATION_URL: url("optimiq_cdr", host) });
	execFileSync("node", [".scripts/migrate-platform.mjs", "--expected-stage", "test"], {
		cwd: root, env: { ...process.env, ...databases(), NODE_ENV: "test", DATABASE_DEPLOYMENT_STAGE: "test", APP_ENV_CONTENT: "" }, stdio: "inherit",
	});
	console.log("PASS: all four migration journals applied to fresh databases");
	const roles = { NATS: "operator-test", NATS_SYS: "sys-test", NATS_API: "api-test", NATS_ENGINE: "engine-test", NATS_SIPD: "sip-test", NATS_MEDIAD: "media-test" };
	const natsEnv = Object.fromEntries(Object.entries(roles).flatMap(([key, value]) => [[`${key}_USER`, value], [`${key}_PASS`, password]]));
	start("nats", "nats:2.11.8", natsEnv, ["-v", `${resolve(root, "config/nats.conf")}:/etc/nats/nats.conf:ro`], ["-c", "/etc/nats/nats.conf"]);
	const webPort = await freePort();
	const origin = `http://127.0.0.1:${webPort}`;
	let sipPort;
	if (mediaIP) {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", resolve(scratch, "key.pem"), "-out", resolve(scratch, "cert.pem")], { stdio: "pipe" });
		chmodSync(scratch, 0o755); chmodSync(resolve(scratch, "key.pem"), 0o644);
		const sip = start("sipd", "optimiq-voice-audit/sipd:local", { NATS_URL: "nats://nats:4222", NATS_SIPD_USER: "sip-test", NATS_SIPD_PASS: password,
			SIPD_REALM: "test.example", SIPD_NONCE_SECRET: password, SIPD_CREDENTIAL_SOURCE: "nats", SIPD_INVITE: "true", SIPD_WSS: "true",
			SIPD_WSS_LISTEN_ADDR: "0.0.0.0:8089", SIPD_TLS_CERT_FILE: "/certs/cert.pem", SIPD_TLS_KEY_FILE: "/certs/key.pem", SIPD_HEALTH_ADDR: "0.0.0.0:8080" },
			["-p", "127.0.0.1::8089", "-v", `${scratch}:/certs:ro`]);
		sipPort = await port(sip, 8089);
	}
	start("api", "optimiq-voice-audit/api:local", { ...databases("postgres:5432"), NODE_ENV: "development", AUTH_SECRET: password,
		AUTH_URL: origin, API_APP_URL: origin, SMTP_HOST: "host.docker.internal", SMTP_PORT: String(smtp.port), SMTP_SECURE: "false", MAIL_FROM: "Voice Test <voice@example.test>", API_NATS_URL: "nats://nats:4222", NATS_URL: "nats://nats:4222",
		NATS_API_USER: "api-test", NATS_API_PASS: password, PROVISION_SIP_SECRET_KEY: password,
		PROVISION_SIP_SERVER: "test.example", PROVISION_BASE_URL: origin,
		...(mediaIP ? { PROVISION_WEBRTC_ENABLED: "true", PROVISION_SIP_WSS_URL: `wss://127.0.0.1:${sipPort}` } : {}), CDR_RECORDING_ROOT: "/tmp/objects",
		CDR_EXPORT_ROOT: "/tmp/exports", CDR_RECORDING_URL_SECRET: password, LOG_LEVEL: "warn", LOG_PRETTY: "false" }, ["-v", `${objects}:/tmp/objects`]);
	start("mediad", "optimiq-voice-audit/mediad:local", { NATS_URL: "nats://nats:4222", NATS_MEDIAD_USER: "media-test", NATS_MEDIAD_PASS: password,
		MEDIAD_PUBLIC_IP: mediaIP ?? "127.0.0.1", MEDIAD_HEALTH_ADDR: "0.0.0.0:8080", MEDIAD_RECORDINGS_DIR: "/tmp/recordings",
		...(mediaIP ? { MEDIAD_WEBRTC: "true", MEDIAD_WEBRTC_PORT_MIN: "44000", MEDIAD_WEBRTC_PORT_MAX: "44019" } : {}) },
		["-v", `${objects}:/tmp/recordings`, ...(mediaIP ? ["-p", "44000-44019:44000-44019/udp"] : [])]);
	await until(() => run(["inspect", "--format", "{{.State.Health.Status}}", `${prefix}-mediad`]) === "healthy", "media startup");
	start("engine", "optimiq-voice-audit/engine:local", { NODE_ENV: "production", ENGINE_MEDIA_DRIVER: "mediad", ENGINE_INSTANCE_ID: "stack-test-engine",
		NATS_URL: "nats://nats:4222", NATS_ENGINE_USER: "engine-test", NATS_ENGINE_PASS: password, ENGINE_SIP_REALM: "test.example", LOG_LEVEL: "debug" });
	start("web", "optimiq-voice-audit/web:local", { PORT: "3100", HOSTNAME: "0.0.0.0" }, ["-p", `127.0.0.1:${webPort}:3100`]);
	await until(async () => (await fetch(`${origin}/api/auth/ok`)).ok, "API through Next proxy", 90000);
	console.log("PASS: containerized web proxies to the full API");
	await until(() => run(["exec", `${prefix}-engine`, "node", "-e", "fetch('http://127.0.0.1:4010/healthz').then(async r=>{if(!r.ok)throw Error(await r.text());console.log('ready')}).catch(e=>{console.error(e.message);process.exit(1)})"]) === "ready", "engine readiness");
	console.log("PASS: full engine startup and media readiness");
	const cookies = new Map();
	async function request(method, path, body) {
		const response = await fetch(origin + path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Origin: origin,
			Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") }, body: body === undefined ? undefined : JSON.stringify(body) });
		for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(";")[0], index = pair.indexOf("="); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
		const text = await response.text();
		assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 700)}`);
		return text ? JSON.parse(text) : undefined;
	}
	const signedUp = await request("POST", "/api/auth/sign-up/email", { name: "Calling Test", email: `${prefix}@example.test`, password: `${password}!Aa1` });
	const organization = await request("POST", "/api/auth/organization/create", { name: "Calling Test", slug: prefix });
	await request("POST", "/api/auth/organization/set-active", { organizationId: organization.id });
	await request("PATCH", "/api/v1/org-settings/categories/sip", { realm: "test.example" });
	const extension = await request("POST", "/api/v1/extensions", { number: "1001", label: "Test Desk", sipSecretRef: "secret://test/1001", enabled: true, voicemailEnabled: false });
	assert.ok(extension.data.id);
	assert.equal((await fetch(`${origin}/api/v1/me/softphone`, { headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } })).status, 404);
	const assignment = await request("POST", `/api/v1/extensions/${extension.data.id}/users`, { userId: signedUp.user.id, role: "primary" });
	const softphone = await request("GET", "/api/v1/me/softphone");
	assert.equal(softphone.extension.id, extension.data.id);
	assert.equal(softphone.account.realm, "test.example");
	assert.ok(softphone.account.password.length > 10);
	await request("DELETE", `/api/v1/extensions/${extension.data.id}/users/${assignment.data.id}`);
	assert.equal((await fetch(`${origin}/api/v1/me/softphone`, { headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } })).status, 404);
	console.log("PASS: assignment grants softphone credentials; removal denies further credential retrieval");

	const listed = await request("GET", "/api/v1/extensions");
	assert.ok(listed.data.some(row => row.id === extension.data.id));
	assert.equal((await fetch(`${origin}/api/v1/extensions`)).status, 401);
	console.log("PASS: authenticated signup, organization, SIP domain and extension persistence through Next");
	if (process.env.PLAYWRIGHT_MODULE) {
		const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
		browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required"] });
		const context = await browser.newContext();
		if (mediaIP) await installAudio(context);
		await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: origin })));
		page = await context.newPage();
		const errors = [];
		page.on("pageerror", error => errors.push(error.message));
		await page.goto(`${origin}/extensions`);
		await page.getByRole("heading", { name: "Extensions", exact: true }).waitFor();
		await page.getByRole("button", { name: "Actions for extension 1001" }).click();
		await page.getByRole("menuitem", { name: "Assign users" }).click();
		await page.getByLabel("Member", { exact: true }).selectOption(signedUp.user.id);
		await page.getByRole("button", { name: "Assign user", exact: true }).click();
		await page.getByText("Calling Test", { exact: false }).filter({ visible: true }).first().waitFor();
		await page.getByRole("button", { name: "Remove", exact: true }).waitFor();
		assert.equal((await request("GET", "/api/v1/me/softphone")).extension.id, extension.data.id);
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await page.getByText("No users assigned.", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Done", exact: true }).click();
		assert.deepEqual(errors, []);
		console.log("PASS: authenticated browser assigns and removes extension users without runtime errors");
		if (mediaIP) {
			await request("POST", `/api/v1/extensions/${extension.data.id}/users`, { userId: signedUp.user.id });
			const secondExtension = await request("POST", "/api/v1/extensions", { number: "1002", label: "Second Desk", sipSecretRef: "secret://test/1002", voicemailEnabled: false });
			const ownerCookies = new Map(cookies);
			cookies.clear();
			const secondEmail = `${prefix}-second@example.test`;
			const second = await request("POST", "/api/auth/sign-up/email", { name: "Second Caller", email: secondEmail, password: `${password}!Aa2` });
			await request("POST", "/api/auth/send-verification-email", { email: secondEmail, callbackURL: `${origin}/softphone` });
				let verificationUrl;
				await until(() => {
					const message = smtp.messages.find(message => message.recipient.includes(secondEmail) && message.body.includes("verify-email"));
					const body = message?.body.replace(/=\r\n/g, "").replace(/=3D/g, "=").replace(/&amp;/g, "&");
					verificationUrl = body?.match(/https?:\/\/[^\s"<>]*verify-email[^\s"<>]*/)?.[0];
					return Boolean(verificationUrl);
				}, "verification mail");
				const verified = await fetch(verificationUrl, { redirect: "manual", headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } });
				assert.ok(verified.status < 400, "email verification failed");
				for (const cookie of verified.headers.getSetCookie()) { const pair = cookie.split(";")[0], index = pair.indexOf("="); cookies.set(pair.slice(0, index), pair.slice(index + 1)); }
				assert.equal((await request("GET", "/api/auth/get-session?disableCookieCache=true")).user.emailVerified, true);

				const secondCookies = new Map(cookies);
			cookies.clear(); for (const [key, value] of ownerCookies) cookies.set(key, value);
			const invitation = await request("POST", "/api/auth/organization/invite-member", { email: secondEmail, role: "user", organizationId: organization.id });
			cookies.clear(); for (const [key, value] of secondCookies) cookies.set(key, value);
			await request("POST", "/api/auth/organization/accept-invitation", { invitationId: invitation.id });
			await request("POST", "/api/auth/organization/set-active", { organizationId: organization.id });
			const calleeCookies = new Map(cookies);
			cookies.clear(); for (const [key, value] of ownerCookies) cookies.set(key, value);
			await request("POST", `/api/v1/extensions/${secondExtension.data.id}/users`, { userId: second.user.id });
			const calleeContext = await browser.newContext();
			await installAudio(calleeContext);
			await calleeContext.addCookies([...calleeCookies].map(([name, value]) => ({ name, value, url: origin })));
			const callee = await calleeContext.newPage();
			callee.on("pageerror", error => errors.push(error.message));
			await page.goto(`${origin}/softphone`);
			await callee.goto(`${origin}/softphone`);
			for (const tab of [page, callee]) {
				await tab.getByRole("button", { name: "Go online", exact: true }).first().click();
				await tab.getByText("Online", { exact: true }).first().waitFor();
			}
			let dialed = "1002";
			if (process.env.CALL_SCENARIO === "ring-group") {
				const offline = await request("POST", "/api/v1/extensions", { number: "1003", label: "Offline Desk", sipSecretRef: "secret://test/1003", enabled: true, voicemailEnabled: false });
				const group = await request("POST", "/api/v1/ring-groups", { name: "Front Desk", extensionNumber: "2000", strategy: process.env.RING_STRATEGY ?? "sequential", enabled: true });
				for (const [ordinal, member] of [offline.data.id, secondExtension.data.id].entries()) {
					await request("POST", `/api/v1/ring-groups/${group.data.id}/destinations`, { ordinal, destinationType: "extension", destinationRef: member, timeoutSeconds: 5, enabled: true });
				}
				dialed = "2000";
			}
			if (process.env.CALL_SCENARIO === "queue") {
				const queue = await request("POST", "/api/v1/queues", { name: "Support", extensionNumber: "3000", maxWaitSeconds: 30, wrapUpSeconds: 0, enabled: true, ...(process.env.CALL_RECORDING === "true" ? { recordPolicy: "all" } : {}) });
				const agent = await request("POST", "/api/v1/queue-agents", { name: "Support Agent", userId: second.user.id, contactKind: "extension", extensionId: secondExtension.data.id, enabled: true });
				await request("POST", `/api/v1/queues/${queue.data.id}/tiers`, { queueAgentId: agent.data.id, level: 1, position: 1 });
				await request("POST", `/api/v1/queue-agents/${agent.data.id}/session/login`, {});
				dialed = "3000";
			}
			let originatedCall;
			if (process.env.CALL_SCENARIO === "click-to-call") {
				originatedCall = (await request("POST", "/api/v1/calls", { from: "1001", to: dialed, ringTimeoutSeconds: 15 })).data;
				await page.getByRole("button", { name: "Answer", exact: true }).first().waitFor();
				assert.equal(await callee.getByRole("button", { name: "Answer", exact: true }).count(), 0, "destination must not ring before caller answers");
				await page.getByRole("button", { name: "Answer", exact: true }).first().click();
			} else {
				await page.getByPlaceholder("Extension or number").fill(dialed);
				await page.getByRole("button", { name: "Call", exact: true }).first().click();
			}
			await callee.getByRole("button", { name: "Answer", exact: true }).first().click();
			for (const tab of [page, callee]) await until(async () => await tab.evaluate(async () => {
				for (const pc of window.testConnections ?? []) {
					for (const report of (await pc.getStats()).values()) if (report.type === "inbound-rtp" && report.kind === "audio" && report.packetsReceived > 20 && report.totalAudioEnergy > 0) return true;
				} return false;
			}), "real application two-way audio", 20000);
			await page.getByRole("button", { name: "Hold", exact: true }).first().click();
			await until(async () => page.evaluate(() => window.testConnections.at(-1)?.signalingState === "stable" && window.testConnections.at(-1)?.remoteDescription?.sdp.includes("a=recvonly")), "hold negotiation");
			await delay(Number(process.env.HOLD_DURATION_MS ?? 500));
			await page.getByRole("button", { name: "Resume", exact: true }).first().click();
			await until(async () => page.evaluate(() => window.testConnections.at(-1)?.signalingState === "stable" && window.testConnections.at(-1)?.localDescription?.sdp.includes("a=sendrecv")), "resume negotiation");
			for (const tab of [page, callee]) {
				const energy = () => tab.evaluate(async () => {
					let energy = 0;
					for (const pc of window.testConnections ?? []) for (const report of (await pc.getStats()).values()) if (report.type === "inbound-rtp" && report.kind === "audio") energy += report.totalAudioEnergy ?? 0;
					return energy;
				});
				const before = await energy();
				await until(async () => (await energy()) > before, "audio after resume");
			}
			console.log("PASS: hold and resume negotiate and restore bidirectional audio through the application");
			assert.deepEqual(errors, []);
			await page.getByRole("button", { name: "Hang up", exact: true }).first().click();
			await callee.getByText("Call ended", { exact: true }).first().waitFor();
			await callee.getByRole("button", { name: "Done", exact: true }).first().click();
			await callee.getByRole("button", { name: "Call", exact: true }).first().waitFor();
			console.log(`PASS: two authenticated users complete ${process.env.CALL_SCENARIO ?? "extension"} calling to ${dialed} with audio and hangup`);
			await until(async () => (await request("GET", "/api/v1/cdr")).data.length >= 2, "both call legs persisted to call history", 20000);
			const history = (await request("GET", "/api/v1/cdr")).data;
			assert.equal(new Set(history.map(leg => leg.callId)).size, 1);
			if (originatedCall) {
				assert.equal(history[0].callId, originatedCall.callId);
				assert.ok(history.some(leg => leg.id === originatedCall.legId));
			}
			console.log("PASS: both call legs persist under one call in authenticated history");
			if (process.env.CALL_RECORDING === "true") {
				await until(async () => (await request("GET", "/api/v1/recordings")).data.some(recording => recording.callId === history[0].callId && recording.durationMs > 0), "finalized call recording", 20000);
				const recording = (await request("GET", "/api/v1/recordings")).data.find(recording => recording.callId === history[0].callId);
				assert.ok(history.some(leg => leg.id === recording.legId), "recording links to a persisted call leg");
				const link = await request("POST", `/api/v1/recordings/${recording.id}/download-url`, {});
				const audio = await fetch(new URL(link.data.url, origin));
				assert.equal(audio.status, 200);
				const wav = Buffer.from(await audio.arrayBuffer());
				assert.equal(wav.toString("ascii", 0, 4), "RIFF");
				assert.ok(wav.length > 8000);
				assert.equal(Number(recording.sizeBytes), wav.length, "stored recording size matches finalized WAV");
				let dataOffset = 12;
				while (dataOffset + 8 <= wav.length && wav.toString("ascii", dataOffset, dataOffset + 4) !== "data") dataOffset += 8 + wav.readUInt32LE(dataOffset + 4) + (wav.readUInt32LE(dataOffset + 4) % 2);
				assert.ok(dataOffset + 8 < wav.length, "WAV has audio data");
				let energy = 0;
				for (let offset = dataOffset + 8; offset + 1 < wav.length; offset += 2) energy += Math.abs(wav.readInt16LE(offset));
				assert.ok(energy > 10000, "recording contains non-silent PCM audio");
				console.log("PASS: recording finalizes, links to call history and downloads through an authenticated signed link");
			}
			await until(() => {
				const logs = spawnSync("docker", ["logs", `${prefix}-mediad`], { encoding: "utf8" });
				return (logs.stdout + logs.stderr).split("\n").some(line => line.includes('"msg":"session released"') && line.includes('"live":0'));
			}, "media sessions released after hangup");
			console.log("PASS: remote hangup releases both media sessions");
			if (originatedCall) {
				await page.getByRole("button", { name: "Done", exact: true }).first().click();
				const unanswered = (await request("POST", "/api/v1/calls", { from: "1001", to: "1002", ringTimeoutSeconds: 5 })).data;
				await page.getByRole("button", { name: "Answer", exact: true }).first().waitFor();
				await until(async () => (await request("GET", "/api/v1/cdr")).data.some(leg => leg.callId === unanswered.callId), "unanswered caller CDR", 15000);
				const failedLegs = (await request("GET", "/api/v1/cdr")).data.filter(leg => leg.callId === unanswered.callId);
				assert.equal(failedLegs.length, 1);
				assert.equal(failedLegs[0].billsecMs, 0);
				assert.equal(failedLegs[0].answeredAt, null);
				assert.equal(await callee.getByRole("button", { name: "Answer", exact: true }).count(), 0);
				await until(() => {
					const logs = spawnSync("docker", ["logs", `${prefix}-mediad`], { encoding: "utf8" });
					return (logs.stdout + logs.stderr).split("\n").some(line => line.includes('"msg":"session released"') && line.includes(unanswered.legId) && line.includes('"live":0'));
				}, "unanswered caller media cleanup");
				console.log("PASS: unanswered click-to-call never rings the destination, bills zero and releases media");
			}
			const sipLogs = spawnSync("docker", ["logs", `${prefix}-sipd`], { encoding: "utf8" });
			assert.doesNotMatch(sipLogs.stdout + sipLogs.stderr, /cannot perform a dialog effect/);
			assert.match(sipLogs.stdout + sipLogs.stderr, /trunk directory loaded/);
			assert.match(sipLogs.stdout + sipLogs.stderr, /directory watcher attached after startup/);
			console.log("PASS: SIP directory watchers recover when the control plane starts later");
		}

	}

	console.log(`PASS: fresh organization ${organization.id}; user ${signedUp.user.id}`);
} catch (error) {
	if (page) console.error("Browser state:", await page.locator("body").innerText().catch(() => "unavailable"));
	for (const id of containers) {
		try { const logs = spawnSync("docker", ["logs", "--tail", "300", id], { encoding: "utf8" }); const output = logs.stdout + logs.stderr; console.error(`${id}:\n${output.replaceAll(password, "[test-secret]")}`); } catch (failure) { console.error(String(failure.stderr ?? failure).replaceAll(password, "[test-secret]")); }
	}
	throw error;
} finally {
	await browser?.close();
	await smtp?.close();
	await database?.end({ timeout: 1 });
	for (const id of containers.reverse()) { try { run(["rm", "-f", id]); } catch {} }
	try { run(["network", "rm", prefix]); } catch {}
	rmSync(scratch, { recursive: true, force: true });
}
