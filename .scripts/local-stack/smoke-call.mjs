import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end smoke call against the STANDING stack: two users signed up through the real web app,
// an organization, two extensions, two browser softphones, measured two-way audio, hold/resume,
// hangup and the resulting call history. Nothing here is a fixture except the mail sink, which is
// a file directory rather than an in-process array because the stack outlives this script.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "apps/web/package.json"));
const { chromium } = require("playwright");
const origin = process.env.STACK_ORIGIN ?? "http://127.0.0.1:3300";
const mailDir = process.env.MAIL_DIR ?? resolve(root, "mail");
const run = `smoke${Date.now().toString(36)}`;
// A SIP realm is a deployment-wide unique claim, so the run gets its OWN subdomain rather than the
// stack's `local.test` — which the standing smoke org already holds, and which the write-time
// uniqueness check now refuses with a 409. Per-tenant realms are supported, so a fresh subdomain is
// a complete tenant: sipd derives the org from the domain in the REGISTER.
const realm = process.env.STACK_REALM ?? `${run}.local.test`;
const password = `${run}!Aa1zZ9`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let browser;

async function until(check, label, ms = 20000) {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try { const value = await check(); if (value) return value; } catch (error) { last = error; }
		await delay(200);
	}
	throw Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}

const jar = new Map();
function header() { return [...jar].map(([k, v]) => `${k}=${v}`).join("; "); }
async function request(method, path, body) {
	const response = await fetch(origin + path, {
		method, headers: { Origin: origin, Cookie: header(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	for (const cookie of response.headers.getSetCookie()) {
		const pair = cookie.split(";")[0], index = pair.indexOf("=");
		jar.set(pair.slice(0, index), pair.slice(index + 1));
	}
	const text = await response.text();
	assert.ok(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 600)}`);
	return text ? JSON.parse(text) : undefined;
}

// A softphone tab that produces a 660 Hz tone instead of a microphone, and records every
// RTCPeerConnection so the audio assertions can read real getStats() counters off the page.
async function instrument(context) {
	await context.addInitScript(() => {
		window.testConnections = [];
		const Native = window.RTCPeerConnection;
		window.RTCPeerConnection = class extends Native {
			constructor(config) { super(config); window.testConnections.push(this); }
		};
		navigator.mediaDevices.getUserMedia = async () => {
			const audio = new AudioContext(); await audio.resume();
			const oscillator = audio.createOscillator(), output = audio.createMediaStreamDestination();
			oscillator.frequency.value = 660; oscillator.connect(output); oscillator.start();
			return output.stream;
		};
	});
}

const inboundAudio = (tab) => tab.evaluate(async () => {
	let packets = 0, energy = 0;
	for (const pc of window.testConnections ?? []) {
		for (const report of (await pc.getStats()).values()) {
			if (report.type === "inbound-rtp" && report.kind === "audio") {
				packets += report.packetsReceived ?? 0;
				energy += report.totalAudioEnergy ?? 0;
			}
		}
	}
	return { packets, energy };
});

function verificationLink(email) {
	for (const file of readdirSync(mailDir).sort().reverse()) {
		const raw = readFileSync(resolve(mailDir, file), "utf8");
		if (!raw.includes(email)) continue;
		const body = raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=").replace(/&amp;/g, "&");
		const link = body.match(/https?:\/\/[^\s"<>]*verify-email[^\s"<>]*/)?.[0];
		if (link) return link;
	}
	return undefined;
}

try {
	const ownerEmail = `${run}-owner@local.test`;
	const owner = await request("POST", "/api/auth/sign-up/email", { name: "Smoke Owner", email: ownerEmail, password });
	const organization = await request("POST", "/api/auth/organization/create", { name: "Smoke Org", slug: run });
	await request("POST", "/api/auth/organization/set-active", { organizationId: organization.id });
	// The SIP domain is a deployment-wide unique claim; see `realm` above for why each run mints its
	// own rather than sharing the stack's.
	await request("PATCH", "/api/v1/org-settings/categories/sip", { realm }).catch((error) => {
		throw Error(`${error.message}\n\nThe realm ${realm} could not be claimed. Every run generates its own, so this is a real failure rather than a leftover from a previous run — do NOT reset the database.`);
	});
	const first = await request("POST", "/api/v1/extensions", { number: "1001", label: "Smoke Desk 1", sipSecretRef: `secret://${run}/1001`, enabled: true, voicemailEnabled: false });
	const second = await request("POST", "/api/v1/extensions", { number: "1002", label: "Smoke Desk 2", sipSecretRef: `secret://${run}/1002`, enabled: true, voicemailEnabled: false });
	await request("POST", `/api/v1/extensions/${first.data.id}/users`, { userId: owner.user.id, role: "primary" });
	console.log(`PASS: organization ${organization.id}, extensions 1001=${first.data.id} 1002=${second.data.id}`);
	results.organizationId = organization.id;
	results.extensions = { "1001": first.data.id, "1002": second.data.id };
	results.owner = { email: ownerEmail, id: owner.user.id };

	const ownerCookies = new Map(jar);
	jar.clear();
	const calleeEmail = `${run}-callee@local.test`;
	const callee = await request("POST", "/api/auth/sign-up/email", { name: "Smoke Callee", email: calleeEmail, password });
	await request("POST", "/api/auth/send-verification-email", { email: calleeEmail, callbackURL: `${origin}/softphone` });
	const link = await until(() => verificationLink(calleeEmail), "verification mail through the SMTP fixture");
	const verified = await fetch(link, { redirect: "manual", headers: { Cookie: header() } });
	assert.ok(verified.status < 400, `email verification failed: ${verified.status}`);
	for (const cookie of verified.headers.getSetCookie()) {
		const pair = cookie.split(";")[0], index = pair.indexOf("=");
		jar.set(pair.slice(0, index), pair.slice(index + 1));
	}
	assert.equal((await request("GET", "/api/auth/get-session?disableCookieCache=true")).user.emailVerified, true);
	console.log("PASS: second user verified through the captured mail");
	results.callee = { email: calleeEmail, id: callee.user.id };

	const calleeSignedUp = new Map(jar);
	jar.clear(); for (const [k, v] of ownerCookies) jar.set(k, v);
	const invitation = await request("POST", "/api/auth/organization/invite-member", { email: calleeEmail, role: "user", organizationId: organization.id });
	jar.clear(); for (const [k, v] of calleeSignedUp) jar.set(k, v);
	await request("POST", "/api/auth/organization/accept-invitation", { invitationId: invitation.id });
	await request("POST", "/api/auth/organization/set-active", { organizationId: organization.id });
	const calleeCookies = new Map(jar);
	jar.clear(); for (const [k, v] of ownerCookies) jar.set(k, v);
	await request("POST", `/api/v1/extensions/${second.data.id}/users`, { userId: callee.user.id });

	browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required"] });
	const errors = [];
	const open = async (cookies) => {
		const context = await browser.newContext();
		await instrument(context);
		await context.addCookies([...cookies].map(([name, value]) => ({ name, value, url: origin })));
		const tab = await context.newPage();
		tab.on("pageerror", (error) => errors.push(error.message));
		await tab.goto(`${origin}/softphone`);
		await tab.getByRole("button", { name: "Go online", exact: true }).first().click();
		await tab.getByText("Online", { exact: true }).first().waitFor({ timeout: 30000 });
		return tab;
	};
	const caller = await open(ownerCookies);
	const receiver = await open(calleeCookies);
	console.log("PASS: both browser softphones registered against sipd over WSS");

	await caller.getByPlaceholder("Extension or number").fill("1002");
	await caller.getByRole("button", { name: "Call", exact: true }).first().click();
	await receiver.getByRole("button", { name: "Answer", exact: true }).first().click({ timeout: 30000 });
	for (const [label, tab] of [["caller", caller], ["callee", receiver]]) {
		const audio = await until(async () => {
			const value = await inboundAudio(tab);
			return value.packets > 20 && value.energy > 0 ? value : undefined;
		}, `two-way audio on the ${label}`, 30000);
		results[`${label}Audio`] = audio;
		console.log(`PASS: ${label} inbound audio packets=${audio.packets} energy=${audio.energy.toFixed(6)}`);
	}

	await caller.getByRole("button", { name: "Hold", exact: true }).first().click();
	await until(() => caller.evaluate(() => window.testConnections.at(-1)?.signalingState === "stable" && window.testConnections.at(-1)?.remoteDescription?.sdp.includes("a=recvonly")), "hold negotiation");
	await delay(1000);
	await caller.getByRole("button", { name: "Resume", exact: true }).first().click();
	await until(() => caller.evaluate(() => window.testConnections.at(-1)?.signalingState === "stable" && window.testConnections.at(-1)?.localDescription?.sdp.includes("a=sendrecv")), "resume negotiation");
	for (const [label, tab] of [["caller", caller], ["callee", receiver]]) {
		const before = (await inboundAudio(tab)).energy;
		const after = await until(async () => { const value = await inboundAudio(tab); return value.energy > before ? value : undefined; }, `audio after resume on the ${label}`);
		results[`${label}AfterResume`] = after;
	}
	console.log("PASS: hold and resume renegotiate and restore audio both ways");

	await caller.getByRole("button", { name: "Hang up", exact: true }).first().click();
	await receiver.getByText("Call ended", { exact: true }).first().waitFor({ timeout: 20000 });
	console.log("PASS: hangup propagates to the far end");
	assert.deepEqual(errors, [], "browser runtime errors");

	jar.clear(); for (const [k, v] of ownerCookies) jar.set(k, v);
	const history = await until(async () => {
		const listed = (await request("GET", "/api/v1/cdr")).data;
		return listed.length >= 2 ? listed : undefined;
	}, "both call legs in call history", 30000);
	assert.equal(new Set(history.map((leg) => leg.callId)).size, 1, "both legs must share one call id");
	results.cdr = history.map((leg) => ({ id: leg.id, callId: leg.callId, billsecMs: leg.billsecMs, answeredAt: leg.answeredAt }));
	console.log(`PASS: ${history.length} legs persisted under call ${history[0].callId}`);

	// Best-effort cleanup of the objects this run can remove without touching anybody else's stack.
	// The two extensions go; the organization, its two users and the call legs STAY — a CDR row is
	// the evidence this run produced, and deleting the org would take it with it. Everything left
	// behind is namespaced by the run id (`smoke<base36>`) and its own realm, so a populated stack
	// accumulates identifiable orgs rather than clashing ones. `SMOKE_KEEP=1` skips even this.
	if (process.env.SMOKE_KEEP !== "1") {
		for (const id of [first.data.id, second.data.id]) {
			await request("DELETE", `/api/v1/extensions/${id}`).catch((error) => {
				console.log(`NOTE: extension ${id} was not removed (${error.message})`);
			});
		}
		console.log(`PASS: extensions removed; organization ${organization.id} and realm ${realm} left in place, namespaced by ${run}`);
	}

	console.log(`\nSMOKE RESULT\n${JSON.stringify(results, null, 2)}`);
} finally {
	await browser?.close();
}
