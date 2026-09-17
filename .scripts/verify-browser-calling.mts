import { SipRenegotiateService } from "../apps/engine/src/media/sip-renegotiate.service";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NatsMediadTransport } from "../apps/engine/src/media/mediad-transport";
import { MediadMediaPort } from "../apps/engine/src/media/mediad-media.port";
import { SplitPlaneMediaPort } from "../apps/engine/src/media/split-plane.port";
import { SipdCommandClient } from "../apps/engine/src/nats/sipd-command.client";

// Two real SIP processes, two real media processes, the product browser adapter and engine ports.
// Only account lookup and admission are fixtures; all network traffic stays on this machine.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(resolve(root, "apps/engine/package.json"));
const { connect, JSONCodec } = require("nats");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const scratch = mkdtempSync(resolve(tmpdir(), "voice-browser-calling-"));
const container = `voice-browser-calling-${process.pid}`;
const secret = randomBytes(24).toString("hex");
const orgId = randomUUID();
const realm = "test.example";
const turnIP = process.env.BROWSER_TURN_PUBLIC_IP;
const turnTransport = process.env.BROWSER_TURN_TRANSPORT ?? "udp";
const turnContainer = `${container}-turn`;
if (!["udp", "tcp"].includes(turnTransport)) throw Error("BROWSER_TURN_TRANSPORT must be udp or tcp");
const codec = JSONCodec();
const processes: ReturnType<typeof spawn>[] = [];
const processLogs: (() => string)[] = [];
const connections: any[] = [];
const endpoints: { socket: ReturnType<typeof createSocket>; timer: ReturnType<typeof setInterval> }[] = [];
const jobs: Promise<unknown>[] = [];
let browser: any;
let http: ReturnType<typeof createServer> | undefined;
let currentCall: { legId: string; callId: string; phoneId: string; received: () => number } | undefined;
let admissionError: unknown;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate: () => Promise<unknown> | unknown, detail: string, ms = 15000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (admissionError) throw admissionError;
		if (await predicate()) return;
		await delay(50);
	}
	throw Error(`Timed out: ${detail}`);
}

async function start(binary: "sipd" | "mediad", environment: Record<string, string>) {
	const child = spawn(resolve(scratch, binary), [], { env: { PATH: process.env.PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
	processes.push(child);
	let output = "";
	child.stdout!.on("data", chunk => output += chunk);
	child.stderr!.on("data", chunk => output += chunk);
	processLogs.push(() => output);
	await until(() => {
		if (child.exitCode !== null) throw Error(`${binary} exited: ${output}`);
		return output.includes(`"msg":"${binary} is up"`);
	}, `${binary} startup`);
	return { child, output: () => output };
}

try {
	for (const binary of ["sipd", "mediad"] as const) execFileSync("go", ["build", "-o", resolve(scratch, binary), `./apps/${binary}/cmd/${binary}`], { cwd: root, stdio: "pipe" });
	execFileSync("bun", ["build", ".scripts/fixtures/browser-softphone.ts", "--target", "browser", "--outfile", resolve(scratch, "browser.js")], { cwd: root, stdio: "pipe" });
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", resolve(scratch, "key.pem"), "-out", resolve(scratch, "cert.pem")], { stdio: "pipe" });
	const users = { NATS: "admin-test", NATS_SYS: "sys-test", NATS_API: "api-test", NATS_ENGINE: "engine-test", NATS_SIPD: "sip-test", NATS_MEDIAD: "media-test" };
	const dockerEnv = Object.entries(users).flatMap(([prefix, user]) => ["-e", `${prefix}_USER=${user}`, "-e", `${prefix}_PASS=${secret}`]);
	execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-p", "127.0.0.1::4222", "-v", `${resolve(root, "config/nats.conf")}:/etc/nats/nats.conf:ro`, ...dockerEnv, "nats:2.11.8", "-c", "/etc/nats/nats.conf"], { stdio: "pipe" });
	let port: string | undefined;
	await until(() => {
		try { port = execFileSync("docker", ["port", container, "4222/tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(":").at(-1); return Number(port) > 0; }
		catch { return false; }
	}, "broker port publication");
	const url = `nats://127.0.0.1:${port}`;
	let admin: any;
	let brokerError: unknown;
	try {
		await until(async () => { try { admin = await connect({ servers: url, user: "admin-test", pass: secret, timeout: 500, maxReconnectAttempts: 0 }); return true; } catch (error) { brokerError = error; return false; } }, "broker startup");
	} catch {
		throw Error(`Broker startup failed: ${String(brokerError)}\n${execFileSync("docker", ["logs", container], { encoding: "utf8" })}`);
	}
	connections.push(admin);
	await (await admin.jetstreamManager()).streams.add({ name: "BROWSER_TEST_EVENTS", subjects: ["sip.evt.v1.>", "sip.reg.v1.>", "media.evt.v1.>"], storage: "memory" });
	const api = await connect({ servers: url, user: "api-test", pass: secret, inboxPrefix: "_INBOX.api" });
	const engine = await connect({ servers: url, user: "engine-test", pass: secret, inboxPrefix: "_INBOX.engine" });
	connections.push(api, engine);
	api.subscribe("rpc.sip.v1.credential", { callback: (error: unknown, message: any) => {
		if (error) { admissionError = error; return; }
		const request = codec.decode(message.data);
		assert.equal(request.realm, realm);
		assert.equal(request.username, "1001");
		message.respond(codec.encode({ found: true, enabled: true, orgId, username: "1001", realm, maxRegistrations: 5, ha1: createHash("md5").update(`1001:${realm}:${secret}`).digest("hex") }));
	} });
	await api.flush();
	if (turnIP) {
		execFileSync("docker", ["run", "--rm", "-d", "--name", turnContainer,
			"-p", "127.0.0.1:13478:3478/udp", "-p", "127.0.0.1:13478:3478/tcp", "-p", "39100-39119:39100-39119/udp",
			"coturn/coturn:4.17.2-r0-alpine@sha256:771a95d04cb97bbc5bfc672e5fdf455591c7d2b2a15f02bb9ceda3e27561695f",
			"-n", "--fingerprint", "--use-auth-secret", `--static-auth-secret=${secret}`, `--realm=${realm}`,
			"--external-ip=127.0.0.1", "--min-port=39100", "--max-port=39119", "--no-tls", "--no-dtls", "--no-cli", "--no-multicast-peers",
			"--denied-peer-ip=0.0.0.0-255.255.255.255", `--allowed-peer-ip=${turnIP}`, "--log-file=stdout", "--verbose"], { stdio: "pipe" });
	}
	for (let index = 0; index < 2; index++) {
		await start("mediad", { NATS_URL: url, NATS_MEDIAD_USER: "media-test", NATS_MEDIAD_PASS: secret,
			MEDIAD_INSTANCE_ID: `media-browser-${index}`, MEDIAD_PUBLIC_IP: turnIP ?? "127.0.0.1", MEDIAD_BIND_IP: turnIP ? "0.0.0.0" : "127.0.0.1", MEDIAD_WEBRTC: "true",
			MEDIAD_RTP_PORT_MIN: String(38000 + index * 100), MEDIAD_RTP_PORT_MAX: String(38099 + index * 100),
			MEDIAD_WEBRTC_PORT_MIN: String(38400 + index * 100), MEDIAD_WEBRTC_PORT_MAX: String(38499 + index * 100),
			MEDIAD_RECORDINGS_DIR: scratch, MEDIAD_SOUNDS_DIR: scratch, MEDIAD_HEALTH_ADDR: "127.0.0.1:0" });
		await start("sipd", { NATS_URL: url, NATS_SIPD_USER: "sip-test", NATS_SIPD_PASS: secret,
			SIPD_INSTANCE_ID: `sip-browser-${index}`, SIPD_REALM: realm, SIPD_NONCE_SECRET: secret, SIPD_CREDENTIAL_SOURCE: "nats", SIPD_INVITE: "true",
			SIPD_LISTEN_ADDR: `127.0.0.1:${35260 + index}`, SIPD_WSS: "true", SIPD_WSS_LISTEN_ADDR: `127.0.0.1:${35290 + index}`,
			SIPD_TLS_CERT_FILE: resolve(scratch, "cert.pem"), SIPD_TLS_KEY_FILE: resolve(scratch, "key.pem"), SIPD_HEALTH_ADDR: "127.0.0.1:0" });
	}
	const transport = new NatsMediadTransport(() => engine);
	const media = new MediadMediaPort(transport, 5000);
	const sip = new SipdCommandClient(() => engine);
	const composite = new SplitPlaneMediaPort(media, sip, undefined, "browser-test-engine");
	const renegotiation = new SipRenegotiateService({ ENGINE_INSTANCE_ID: "browser-test-engine" } as any, { rawConnection: engine } as any, composite);
	renegotiation.onApplicationBootstrap();
	const sipEvents: any[] = [];
	const rpc = async (verb: string, body: unknown) => {
		const reply = await transport.request(`rpc.media.v1.${verb}`, body, 5000) as any;
		assert.equal(reply.ok, true, `${verb}: ${JSON.stringify(reply)}`);
		return reply;
	};
	async function phone(callId: string, legId: string) {
		const phoneId = randomUUID();
		const offer = await rpc("create-offer", { sessionId: phoneId, orgId, callId, direction: "sendrecv" });
		const socket = createSocket("udp4");
		await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve));
		let received = 0, sequence = 0;
		socket.on("message", packet => { if (packet.length >= 172 && (packet[1]! & 0x7f) === 0 && packet.subarray(12).some(value => value < 240)) received++; });
		const timer = setInterval(() => {
			const packet = Buffer.alloc(172, 0x30);
			packet[0] = 0x80; packet[1] = 0;
			packet.writeUInt16BE(sequence++ % 65536, 2); packet.writeUInt32BE(sequence * 160, 4); packet.writeUInt32BE(4512, 8);
			socket.send(packet, offer.rtpPort, "127.0.0.1");
		}, 20);
		endpoints.push({ socket, timer });
		await rpc("bridge-sessions", { bridgeId: randomUUID(), sessionIds: [legId, phoneId] });
		return { legId, callId, phoneId, received: () => received };
	}
	engine.subscribe("rpc.sip.v1.invite", { callback: (error: unknown, message: any) => {
		if (error) { admissionError = error; return; }
		const request = codec.decode(message.data);
		const callId = randomUUID();
		message.respond(codec.encode({ ok: true, legId: request.legId, orgId, callId, instanceId: "browser-test-engine", routingContext: request.routingContext, direction: "outbound" }));
		jobs.push((async () => {
			composite.registerInboundLeg(request.legId, { orgId, callId, sipdInstanceId: request.sipdInstanceId, sdpOffer: request.sdpOffer });
			await composite.answer(request.legId);
			currentCall = await phone(callId, request.legId);
		})().catch(error => admissionError = error));
	} });
	const outgoing = new Set<string>();
	engine.subscribe("sip.evt.v1.>", { callback: (error: unknown, message: any) => {
		if (error) { admissionError = error; return; }
		const event = codec.decode(message.data);
		sipEvents.push(event);
		if (event.type === "dialog.answered" && outgoing.has(event.data.legId)) {
			jobs.push(composite.settleOutboundAnswer(event.data.legId, event.data.sdpAnswer).then(reply => assert.equal(reply.ok, true, JSON.stringify(reply))).catch(error => admissionError = error));
		}
	} });
	await engine.flush();
	http = createServer((request, response) => {
		if (request.url?.startsWith("/credentials")) {
			const index = new URL(request.url, "http://localhost").searchParams.get("edge") ?? "0";
			const username = `${Math.floor(Date.now() / 1000) + 600}:${orgId}:browser`;
			const iceServers = turnIP ? [{ urls: [`turn:127.0.0.1:13478?transport=${turnTransport}`], username, credential: createHmac("sha1", secret).update(username).digest("base64") }] : [];
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ extension: { id: randomUUID(), number: "1001", label: "Test", displayName: "Test" },
				account: { username: "1001", authUsername: "1001", password: secret, realm, registerExpiresSeconds: 300, voicemailNumber: null },
				transport: { wssUrl: `wss://localhost:${35290 + Number(index)}` }, media: { webrtcSupported: true, note: "Test", iceServers } }));
		} else if (request.url === "/browser.js") { response.setHeader("Content-Type", "text/javascript"); response.end(readFileSync(resolve(scratch, "browser.js"))); }
		else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><title>Browser calling verification</title><audio autoplay></audio><script src="/browser.js"></script>'); }
	});
	await new Promise<void>(resolve => http!.listen(0, "127.0.0.1", resolve));
	const address = http.address() as { port: number };
	browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required"] });
	const pages = await Promise.all([browser.newPage(), browser.newPage()]);
	for (const [index, page] of pages.entries()) {
		page.on("pageerror", (error: unknown) => admissionError = error);
		await page.goto(`http://127.0.0.1:${address.port}/?edge=${index}${turnIP ? "&relay=1" : ""}`);
		await page.waitForFunction(() => (window as any).events.some((event: any) => event.state === "registered"), undefined, { timeout: 15000 });
	}
	console.log("PASS: two browsers registered the same extension on separate WSS processes");
	const groups = await composite.resolveTargets(orgId, { kind: "aor", aor: `sip:1001@${realm}` });
	assert.equal(groups.flat().length, 2, "one browser registration overwrote the other");
	for (const target of groups.flat()) {
		const resolved = await sip.resolveTarget({ legId: "probe", orgId, target });
		const index = Number(resolved.instanceId!.at(-1));
		const page = pages[index];
		const legId = randomUUID(), callId = randomUUID();
		outgoing.add(legId);
		composite.registerOutboundLeg(legId, { orgId, callId });
		await composite.originate({ channelId: legId, endpoint: "PJSIP/1001", application: "engine", target });
		currentCall = await phone(callId, legId);
		await verifyCall(page, `incoming call to browser ${index}`);
		await composite.hangup(legId, "NORMAL_CLEARING");
		await rpc("release-session", { sessionId: currentCall.phoneId });
		outgoing.delete(legId);
		currentCall = undefined;
	}
	const page = pages[0];
	await page.evaluate(() => (window as any).client.call("1002"));
	await until(() => currentCall !== undefined, "outgoing browser call admission");
	await verifyCall(page, "outgoing browser call");
	if (turnIP) {
		execFileSync("docker", ["kill", turnContainer], { stdio: "pipe" });
		await delay(250);
		const before = await page.evaluate(async () => (await (window as any).audioEvidence())?.packetsReceived ?? 0);
		await delay(500);
		const after = await page.evaluate(async () => (await (window as any).audioEvidence())?.packetsReceived ?? 0);
		assert.ok(after <= before + 3, "audio bypassed the failed TURN relay");
		console.log("PASS: relay loss stops audio without bypassing relay-only policy");
	}
	const active = currentCall!;
	await page.evaluate(() => (window as any).client.hangup());
	await composite.hangup(active.legId, "NORMAL_CLEARING");
	await rpc("release-session", { sessionId: active.phoneId });
	assert.ok(await page.evaluate(() => (window as any).refreshes) >= 3, "TURN credentials were not refreshed before each call");
	await Promise.all(jobs);
	if (admissionError) throw admissionError;
	console.log("PASS: credential refresh, SIP authentication, WSS flow routing, two-way encrypted audio, recording and teardown");

	async function verifyCall(page: any, label: string) {
		let evidence: unknown;
		try { await until(async () => {
			const evidence = await page.evaluate(() => (window as any).audioEvidence());
			return evidence?.packetsReceived > 30 && evidence?.totalAudioEnergy > 0 && currentCall!.received() > 30;
		}, `${label}: bidirectional audio`); } catch (error) {
			evidence = await page.evaluate(async () => ({ events: (window as any).events, audio: await (window as any).audioEvidence(), connections: (window as any).connections.map((pc: RTCPeerConnection) => ({ connection: pc.connectionState, signalling: pc.signalingState, local: pc.localDescription?.sdp, remote: pc.remoteDescription?.sdp })) }));
			console.error(JSON.stringify({ label, evidence, received: currentCall?.received() }));
			if (turnIP) console.error(execFileSync("docker", ["logs", turnContainer], { encoding: "utf8" }).replaceAll(secret, "[test-secret]"));
			for (const log of processLogs) console.error(log().split("\n").slice(-15).join("\n").replaceAll(secret, "[test-secret]"));
			throw error;
		}
		if (turnIP) {
			const candidate = await page.evaluate(async () => {
				const stats = await (window as any).connections.at(-1).getStats();
				const transport = [...stats.values()].find((report: any) => report.type === "transport") as any;
				const pair = stats.get(transport?.selectedCandidatePairId);
				return stats.get(pair?.localCandidateId);
			});
			assert.equal(await page.evaluate(() => (window as any).connections.at(-1).getConfiguration().iceTransportPolicy), "relay");
			// Docker Desktop translates the relay's source port again. Chromium then reports
			// a peer-reflexive candidate retaining its TURN URL and relay transport.
			assert.ok(candidate?.candidateType === "relay" || candidate?.candidateType === "prflx", "no relay candidate selected");
			assert.equal(candidate?.relayProtocol, turnTransport, "call bypassed TURN transport");
			assert.equal(candidate?.url, `turn:127.0.0.1:13478?transport=${turnTransport}`, "call used an unexpected relay");
			console.log(`PASS: ${label} uses authenticated TURN over ${turnTransport}`);
		}
		await page.evaluate(() => (window as any).client.sendDtmf("5"));
		await until(() => sipEvents.some(event => event.type === "dialog.dtmf" && event.data.legId === currentCall!.legId && event.data.digit === "5"), "SIP DTMF reached engine");
		await page.evaluate(() => (window as any).client.setHold(true));
		await until(() => sipEvents.some(event => event.type === "dialog.held" && event.data.legId === currentCall!.legId), "hold SDP accepted by media server");
		try { await page.waitForFunction(() => (window as any).connections.at(-1).signalingState === "stable", undefined, { timeout: 8000 }); }
		catch(error) {
			console.error(JSON.stringify(await page.evaluate(() => ({ errors: (window as any).rtcErrors, events: (window as any).events, connections: (window as any).connections.map((pc: RTCPeerConnection) => ({ state: pc.signalingState, local: pc.localDescription?.sdp, remote: pc.remoteDescription?.sdp })) }))));
			for (const log of processLogs) console.error(log().split("\n").slice(-12).join("\n").replaceAll(secret, "[test-secret]"));
			throw error;
		}
		await delay(200);
		const heldPackets = await page.evaluate(async () => (await (window as any).audioEvidence())?.packetsReceived ?? 0);
		await delay(350);
		const heldAfter = await page.evaluate(async () => (await (window as any).audioEvidence())?.packetsReceived ?? 0);
		assert.ok(heldAfter - heldPackets < 3, "held browser still received conversation audio");
		await page.evaluate(() => (window as any).client.setHold(false));
		await until(() => sipEvents.some(event => event.type === "dialog.resumed" && event.data.legId === currentCall!.legId), "resume SDP accepted by media server");
		await until(async () => {
			const stats = await page.evaluate(() => (window as any).audioEvidence());
			return stats?.packetsReceived > heldAfter + 20 && stats?.totalAudioEnergy > 0;
		}, "audio resumed after hold");
		const recordingRef = randomUUID();
		await rpc("start-recording", { sessionId: currentCall!.legId, recordingRef, direction: "both", format: "wav" });
		await delay(650);
		await rpc("stop-recording", { recordingRef });
		await until(() => { try { return statSync(resolve(scratch, orgId, currentCall!.callId, `${recordingRef}.wav`)).size > 8044; } catch { return false; } }, "recording finalized");
		console.log(`PASS: ${label}, bidirectional audio, DTMF, hold/resume and conversation recording`);
	}
} finally {
	await browser?.close();
	await new Promise<void>(resolve => http ? http.close(() => resolve()) : resolve());
	for (const { socket, timer } of endpoints) { clearInterval(timer); socket.close(); }
	for (const child of processes) child.kill("SIGTERM");
	await Promise.all(processes.map(child => new Promise(resolve => { if (child.exitCode !== null) { resolve(undefined); return; } const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 5000); child.once("exit", () => { clearTimeout(timeout); resolve(undefined); }); })));
	for (const connection of connections) connection.close();
	if (turnIP) { try { execFileSync("docker", ["rm", "-f", turnContainer], { stdio: "pipe" }); } catch {} }
	try { execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" }); } catch {}
	rmSync(scratch, { recursive: true, force: true });
}
