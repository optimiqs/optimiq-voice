import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Local sockets and a throwaway broker only. No carrier, user database or running deployment.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(root, "apps/engine/package.json"));
const { connect, JSONCodec } = require("nats");
const scratch = mkdtempSync(resolve(tmpdir(), "voice-media-cluster-"));
const container = `voice-media-cluster-${process.pid}`;
const password = randomBytes(24).toString("hex");
const children = [];
const connections = [];
const sockets = [];
const healthAddresses = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codec = JSONCodec();
const orgId = randomUUID();
const callId = randomUUID();

async function endpoint() {
	const socket = createSocket("udp4");
	sockets.push(socket);
	await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
	return socket;
}

function receivedAudio(socket, marker) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("RTP audio was not relayed")); }, 2000);
		function receive(packet) {
			if (packet.length < 172 || packet[12] !== marker) return;
			clearTimeout(timer);
			socket.off("message", receive);
			resolve();
		}
		socket.on("message", receive);
	});
}

async function sendAudio(socket, port, marker, sequence) {
	const packet = Buffer.alloc(172, marker);
	packet[0] = 0x80;
	packet[1] = 0;
	packet.writeUInt16BE(sequence, 2);
	packet.writeUInt32BE(sequence * 160, 4);
	packet.writeUInt32BE(marker + 1, 8);
	await new Promise((resolve, reject) => socket.send(packet, port, "127.0.0.1", (error) => error ? reject(error) : resolve()));
}

async function startMedia(index, url) {
	const startPort = 36000 + index * 100;
	const child = spawn(resolve(scratch, "mediad"), [], {
		env: {
			PATH: process.env.PATH,
			NATS_URL: url,
			NATS_MEDIAD_USER: "media-test",
			NATS_MEDIAD_PASS: password,
			MEDIAD_PUBLIC_IP: "127.0.0.1",
			MEDIAD_HEALTH_ADDR: "127.0.0.1:0",
			MEDIAD_BIND_IP: "127.0.0.1",
			MEDIAD_INSTANCE_ID: `media-test-${index}`,
			MEDIAD_RTP_PORT_MIN: String(startPort),
			MEDIAD_RTP_PORT_MAX: String(startPort + 99),
			MEDIAD_SESSION_IDLE_TIMEOUT: "0s",
			MEDIAD_RTP_TIMEOUT: "0s",
			MEDIAD_RECORDINGS_DIR: resolve(scratch, "recordings"),
			MEDIAD_SOUNDS_DIR: resolve(scratch, "sounds"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	await new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`media boot timeout: ${output}`)), 15000);
		let settled = false;
		const consume = (chunk) => {
			if (settled) return;
			output += chunk;
			const ready = output.split("\n").find((line) => line.includes('"msg":"mediad is up"'));
			if (ready) { settled = true; healthAddresses.push(JSON.parse(ready).healthAddr); clearTimeout(timer); resolve(); }
		};
		child.stdout.on("data", consume);
		child.stderr.on("data", consume);
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`media exited ${code}: ${output}`)); });
	});
}

async function startSip(url) {
	const child = spawn(resolve(scratch, "sipd"), [], {
		env: {
			PATH: process.env.PATH, NATS_URL: url, NATS_SIPD_USER: "sip-test", NATS_SIPD_PASS: password,
			SIPD_REALM: "test.example", SIPD_NONCE_SECRET: password, SIPD_CREDENTIAL_SOURCE: "nats",
			SIPD_INVITE: "true", SIPD_LISTEN_ADDR: "127.0.0.1:35060", SIPD_EXTERNAL_LISTEN_ADDR: "127.0.0.1:35088",
			SIPD_TRUNK_ACL: "127.0.0.1/32", SIPD_HEALTH_ADDR: "127.0.0.1:0",
		}, stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	await new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`SIP boot timeout: ${output}`)), 30000);
		let settled = false;
		const consume = (chunk) => {
			if (settled) return;
			output += chunk;
			const ready = output.split("\n").find((line) => line.includes('"msg":"sipd is up"'));
			if (ready) { settled = true; healthAddresses.push(JSON.parse(ready).healthAddr); clearTimeout(timer); resolve(); }
		};
		child.stdout.on("data", consume); child.stderr.on("data", consume);
		child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`SIP exited ${code}: ${output}`)); });
	});
	const socket = await endpoint();
	for (const port of [35060, 35088]) {
		const response = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => { socket.off("message", receive); reject(new Error(`SIP listener ${port} did not answer OPTIONS`)); }, 2000);
			function receive(packet) { clearTimeout(timeout); resolve(packet.toString()); }
			socket.once("message", receive);
		});
		const packet = ["OPTIONS sip:test.example SIP/2.0", `Via: SIP/2.0/UDP 127.0.0.1:${socket.address().port};branch=z9hG4bK-${randomUUID()};rport`,
			"From: <sip:probe@test.example>;tag=probe", "To: <sip:test.example>", `Call-ID: ${randomUUID()}`,
			"CSeq: 1 OPTIONS", "Max-Forwards: 70", "Content-Length: 0", "", ""].join("\r\n");
		socket.send(packet, port, "127.0.0.1");
		assert.match(await response, /^SIP\/2.0 200 /);
	}
}

try {
	mkdirSync(resolve(scratch, "recordings"));
	mkdirSync(resolve(scratch, "sounds"));
	const wave = Buffer.alloc(44 + 16000);
	wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
	wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
	wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(16000, 40);
	writeFileSync(resolve(scratch, "sounds", "cluster.wav"), wave);
	execFileSync("go", ["build", "-o", resolve(scratch, "mediad"), "./apps/mediad/cmd/mediad"], { cwd: root, stdio: "pipe" });
	execFileSync("go", ["build", "-o", resolve(scratch, "sipd"), "./apps/sipd/cmd/sipd"], { cwd: root, stdio: "pipe" });
	const users = { NATS: "admin-test", NATS_SYS: "sys-test", NATS_API: "api-test", NATS_ENGINE: "engine-test", NATS_SIPD: "sip-test", NATS_MEDIAD: "media-test" };
	const dockerEnv = Object.entries(users).flatMap(([prefix, user]) => ["-e", `${prefix}_USER=${user}`, "-e", `${prefix}_PASS=${password}`]);
	execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::4222", "-v", `${resolve(root, "config/nats.conf")}:/etc/nats/nats.conf:ro`, ...dockerEnv, "nats:2.11", "-c", "/etc/nats/nats.conf"], { stdio: "pipe" });
	const port = execFileSync("docker", ["port", container, "4222/tcp"], { encoding: "utf8" }).trim().split(":").at(-1);
	const url = `nats://127.0.0.1:${port}`;
	let admin;
	for (let attempt = 0; attempt < 50; attempt++) {
		try { admin = await connect({ servers: url, user: "admin-test", pass: password, timeout: 500, maxReconnectAttempts: 0 }); break; }
		catch (error) { if (attempt === 49) throw error; await delay(100); }
	}
	connections.push(admin);
	await (await admin.jetstreamManager()).streams.add({ name: "MEDIA", subjects: ["media.evt.v1.>"], storage: "memory" });
	await startMedia(0, url);
	await startMedia(1, url);
	await startSip(url);
	for (const addr of healthAddresses) assert.equal((await fetch(`http://${addr}/readyz`)).status, 200);
	const engine = await connect({ servers: url, user: "engine-test", pass: password, inboxPrefix: "_INBOX.engine" });
	connections.push(engine);
	const request = async (verb, payload, connection = engine) => codec.decode((await connection.request(`rpc.media.v1.${verb}`, codec.encode(payload), { timeout: 4000 })).data);

	// Simultaneous legs may enter different queue subscribers but must bind on one instance.
	const sessions = [randomUUID(), randomUUID()];
	const offers = await Promise.all(sessions.map((sessionId) => request("create-offer", { sessionId, orgId, callId, direction: "sendrecv" })));
	for (const offer of offers) assert.equal(offer.ok, true, JSON.stringify(offer));
	assert.equal(offers[0].instanceId, offers[1].instanceId, "call legs split across media instances");
	const owner = offers[0].instanceId;
	const bridgeId = randomUUID();
	assert.equal((await request("bridge-sessions", { bridgeId, sessionIds: sessions })).ok, true);
	const recordingRef = randomUUID();
	const recorded = await request("start-recording", { sessionId: sessions[0], recordingRef, direction: "both", format: "wav" });
	assert.equal(recorded.ok, true, JSON.stringify(recorded));
	const recordingEvents = engine.subscribe("media.evt.v1.>");
	await engine.flush();
	const [phoneA, phoneB] = await Promise.all([endpoint(), endpoint()]);
	await sendAudio(phoneB, offers[1].rtpPort, 0x66, 1);
	await delay(20);
	const atB = receivedAudio(phoneB, 0x55);
	await sendAudio(phoneA, offers[0].rtpPort, 0x55, 1);
	await atB;
	const atA = receivedAudio(phoneA, 0x66);
	await sendAudio(phoneB, offers[1].rtpPort, 0x66, 2);
	await atA;
	for (let sequence = 3; sequence < 15; sequence++) {
		await sendAudio(phoneA, offers[0].rtpPort, 0x55, sequence);
		await sendAudio(phoneB, offers[1].rtpPort, 0x66, sequence);
		await delay(20);
	}
	const stoppedRecording = await request("stop-recording", { recordingRef });
	assert.equal(stoppedRecording.stopped, true, JSON.stringify(stoppedRecording));
	const recordingDeadline = setTimeout(() => recordingEvents.unsubscribe(), 3000);
	let recordingFinished = false;
	for await (const message of recordingEvents) {
		const event = codec.decode(message.data);
		if (event.type === "recording.finished" && event.data.recordingRef === recordingRef) {
			recordingFinished = true;
			break;
		}
	}
	clearTimeout(recordingDeadline);
	recordingEvents.unsubscribe();
	assert.equal(recordingFinished, true, "recording completion was not published");
	assert.ok(statSync(resolve(scratch, "recordings", orgId, callId, `${recordingRef}.wav`)).size > 44, "recording contains no audio samples");
	const playbackRef = randomUUID();
	const played = await request("start-playback", { sessionId: sessions[0], playbackRef, media: ["sound:cluster"] });
	assert.equal(played.ok, true, JSON.stringify(played));
	assert.equal((await request("stop-playback", { playbackRef })).stopped, true);
	for (let index = 0; index < 40; index++) {
		const response = await request("hold-session", { sessionId: sessions[index % 2], unhold: index % 3 !== 0 });
		assert.equal(response.ok, true, JSON.stringify(response));
		assert.equal(response.instanceId, owner);
	}
	// A second engine has no local ownership cache. Durable resource indexes must still route it.
	const restartedEngine = await connect({ servers: url, user: "engine-test", pass: password, inboxPrefix: "_INBOX.engine" });
	connections.push(restartedEngine);
	const unbridge = await request("unbridge-sessions", { bridgeId }, restartedEngine);
	assert.equal(unbridge.ok, true, JSON.stringify(unbridge));
	assert.equal(unbridge.unbridged, true);
	assert.equal(unbridge.instanceId, owner);
	for (const sessionId of sessions) {
		const released = await request("release-session", { sessionId });
		assert.equal(released.ok, true);
		assert.equal(released.released, true);
		assert.equal(released.instanceId, owner);
	}
	const lostSession = randomUUID();
	const lostOffer = await request("create-offer", { sessionId: lostSession, orgId, callId: randomUUID() });
	assert.equal(lostOffer.ok, true);
	const lostIndex = Number(lostOffer.instanceId.split("-").at(-1));
	const dead = children[lostIndex];
	const exited = new Promise((resolve) => dead.once("exit", resolve));
	dead.kill("SIGKILL");
	await exited;
	await delay(100);
	const failure = await request("hold-session", { sessionId: lostSession, unhold: true });
	assert.equal(failure.ok, false, "a dead owner's session was silently accepted on another node");
	assert.equal(failure.reason, "internal");
	assert.match(failure.error, /owning media instance is unavailable/);
	execFileSync("docker", ["stop", container], { stdio: "pipe" });
	const survivingHealth = healthAddresses.filter((_, index) => index !== lostIndex);
	for (let attempt = 0; attempt < 30; attempt++) {
		const statuses = await Promise.all(survivingHealth.map(async (addr) => (await fetch(`http://${addr}/readyz`)).status));
		if (statuses.every((status) => status === 503)) break;
		if (attempt === 29) assert.fail(`broker loss left services ready: ${statuses}`);
		await delay(100);
	}
	console.log("PASS: concurrent call placement, bidirectional RTP, recorded audio, playback control, 40 routed commands, engine reconnect, bridge cleanup, session release, owner loss, internal and carrier SIP listeners, and readiness after broker loss; real processes with production NATS permissions.");
} finally {
	for (const socket of sockets) socket.close();
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	await Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => {
		child.once("exit", resolve);
		setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2500).unref();
	})));
	await Promise.all(connections.map((connection) => connection.close()));
	try { execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }); } catch {}
	rmSync(scratch, { recursive: true, force: true });
}
