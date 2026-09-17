import { EventEmitter } from "node:events";
import { expect } from "chai";
import { attachUpgradeHandler } from "../../src/core/http/upgrade-router";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

/**
 * The fd-exhaustion guard.
 *
 * Node's `http.Server` destroys an upgrade socket only while the server has NO `'upgrade'`
 * listener. Both WebSocket gateways used to attach one and then `return` for paths they did not
 * own, which left a fully-established socket referenced by nothing — one leaked fd per
 * unauthenticated handshake to any path. These assertions are that the router closes what nobody
 * claims, and does not touch what somebody does.
 */

function fakeSocket(): Duplex & { destroyed: boolean } {
	const socket = new EventEmitter() as unknown as Duplex & { destroyed: boolean };
	socket.destroyed = false;
	socket.destroy = (() => {
		socket.destroyed = true;
		return socket;
	}) as Duplex["destroy"];
	return socket;
}

function fakeServer(): Server {
	return new EventEmitter() as unknown as Server;
}

function upgrade(server: Server, url: string): Duplex & { destroyed: boolean } {
	const socket = fakeSocket();
	server.emit("upgrade", { url, headers: {} } as IncomingMessage, socket, Buffer.alloc(0));
	return socket;
}

/** The listener is async, so a claim resolves on a later microtask than the emit. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("upgrade router", () => {
	it("destroys an upgrade no gateway claims", async () => {
		const server = fakeServer();
		attachUpgradeHandler(server, async () => false);

		const socket = upgrade(server, "/nobody/owns/this");
		await settle();

		expect(socket.destroyed).to.equal(true);
	});

	it("leaves a claimed upgrade alone", async () => {
		const server = fakeServer();
		attachUpgradeHandler(server, async (request) => request.url === "/live");

		const socket = upgrade(server, "/live");
		await settle();

		expect(socket.destroyed).to.equal(false);
	});

	it("offers an unclaimed upgrade to the next gateway rather than closing it first", async () => {
		const server = fakeServer();
		const seen: string[] = [];
		attachUpgradeHandler(server, async () => {
			seen.push("live");
			return false;
		});
		attachUpgradeHandler(server, async (request) => {
			seen.push("session");
			return request.url === "/session";
		});

		const socket = upgrade(server, "/session");
		await settle();

		expect(seen).to.deep.equal(["live", "session"]);
		expect(socket.destroyed).to.equal(false);
	});

	it("installs exactly one listener however many gateways attach", () => {
		const server = fakeServer();
		attachUpgradeHandler(server, async () => false);
		attachUpgradeHandler(server, async () => false);

		expect((server as unknown as EventEmitter).listenerCount("upgrade")).to.equal(1);
	});

	it("destroys the socket when a claim rejects, rather than leaving it half-open", async () => {
		const server = fakeServer();
		attachUpgradeHandler(server, async () => {
			throw new Error("session resolution exploded");
		});

		const socket = upgrade(server, "/live");
		await settle();

		expect(socket.destroyed).to.equal(true);
	});
});
