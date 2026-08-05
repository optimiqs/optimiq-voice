import { describe, expect, it } from "bun:test";
import { AriHttpError, AriResponseShapeError, AriTransportError } from "./errors";
import { AriHttpClient } from "./http-client";
import { ariChannelSchema } from "./models";
import { AriChannels } from "./resources/channels";
import type { AriFetch } from "./http-client";

interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body?: string;
}

/** A fetch double that records requests and replays a scripted list of responses. */
function fakeFetch(responses: readonly (Response | Error)[]) {
	const requests: RecordedRequest[] = [];
	let index = 0;

	const impl: AriFetch = async (input, init) => {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
			headers[key.toLowerCase()] = value;
		}
		requests.push({
			url: String(input),
			method: init.method ?? "GET",
			headers,
			body: typeof init.body === "string" ? init.body : undefined,
		});
		const next = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (next instanceof Error) {
			throw next;
		}
		return next as Response;
	};

	return { impl, requests };
}

function client(responses: readonly (Response | Error)[]) {
	const { impl, requests } = fakeFetch(responses);
	return {
		http: new AriHttpClient({
			baseUrl: "http://asterisk:8088/ari",
			credentials: { username: "ari", password: "secret" },
			fetch: impl,
		}),
		requests,
	};
}

const CHANNEL = {
	id: "1754400000.1",
	name: "PJSIP/trunk-1",
	state: "Up",
};

describe("AriHttpClient", () => {
	it("sends basic auth on every request", async () => {
		const { http, requests } = client([new Response(JSON.stringify(CHANNEL), { status: 200 })]);
		await http.requestParsed({ method: "GET", path: "/channels/x" }, ariChannelSchema);
		expect(requests[0]?.headers.authorization).toBe(
			`Basic ${Buffer.from("ari:secret").toString("base64")}`,
		);
	});

	it("resolves 204 to undefined without parsing a body", async () => {
		const { http } = client([new Response(null, { status: 204 })]);
		await expect(
			http.requestText({ method: "POST", path: "/channels/x/answer" }),
		).resolves.toBeUndefined();
	});

	it("maps a non-2xx to AriHttpError with the status and Asterisk's message", async () => {
		const { http } = client([
			new Response(JSON.stringify({ message: "Endpoint not found" }), { status: 422 }),
		]);
		const failure = await http
			.requestVoid({ method: "POST", path: "/channels" })
			.then(() => undefined)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AriHttpError);
		const error = failure as AriHttpError;
		expect(error.status).toBe(422);
		expect(error.asteriskMessage).toBe("Endpoint not found");
		expect(error.method).toBe("POST");
		expect(error.path).toBe("/channels");
		expect(error.message).toContain("Endpoint not found");
	});

	it("keeps a non-JSON error body without losing the status", async () => {
		const { http } = client([new Response("<html>Bad Gateway</html>", { status: 502 })]);
		const error = (await http
			.requestVoid({ method: "GET", path: "/channels" })
			.catch((caught: unknown) => caught)) as AriHttpError;

		expect(error.status).toBe(502);
		expect(error.asteriskMessage).toBeUndefined();
		expect(error.body).toContain("Bad Gateway");
	});

	it("classifies statuses for the caller", async () => {
		const notFound = new AriHttpError({ status: 404, method: "GET", path: "/x" });
		const conflict = new AriHttpError({ status: 409, method: "GET", path: "/x" });
		const server = new AriHttpError({ status: 503, method: "GET", path: "/x" });
		const refusal = new AriHttpError({ status: 422, method: "GET", path: "/x" });

		expect(notFound.isNotFound).toBe(true);
		expect(conflict.isConflict).toBe(true);
		expect(server.isRetryable).toBe(true);
		expect(refusal.isRetryable).toBe(false);
		expect(notFound.isRetryable).toBe(false);
	});

	it("maps a transport failure to AriTransportError", async () => {
		const { http } = client([new TypeError("fetch failed")]);
		const error = (await http
			.requestVoid({ method: "GET", path: "/asterisk/info" })
			.catch((caught: unknown) => caught)) as AriTransportError;

		expect(error).toBeInstanceOf(AriTransportError);
		expect(error.path).toBe("/asterisk/info");
	});

	it("rejects a 2xx body the schema does not accept", async () => {
		const { http } = client([new Response(JSON.stringify({ name: "no id" }), { status: 200 })]);
		await expect(
			http.requestParsed({ method: "GET", path: "/channels/x" }, ariChannelSchema),
		).rejects.toBeInstanceOf(AriResponseShapeError);
	});

	it("rejects a 2xx body that is not JSON", async () => {
		const { http } = client([new Response("not json", { status: 200 })]);
		await expect(
			http.requestParsed({ method: "GET", path: "/channels/x" }, ariChannelSchema),
		).rejects.toBeInstanceOf(AriResponseShapeError);
	});
});

describe("AriChannels", () => {
	it("reads a channel and resolves an absent one to undefined", async () => {
		const present = client([new Response(JSON.stringify(CHANNEL), { status: 200 })]);
		await expect(new AriChannels(present.http).get("1754400000.1")).resolves.toMatchObject({
			id: "1754400000.1",
		});

		const absent = client([new Response(JSON.stringify({ message: "gone" }), { status: 404 })]);
		await expect(new AriChannels(absent.http).get("1754400000.1")).resolves.toBeUndefined();
	});

	it("percent-encodes a Local channel id, which contains a semicolon", async () => {
		const { http, requests } = client([new Response(null, { status: 204 })]);
		await new AriChannels(http).answer("1754400000.1;2");
		expect(requests[0]?.url).toBe("http://asterisk:8088/ari/channels/1754400000.1%3B2/answer");
	});

	it("sends the numeric hangup cause as reason_code", async () => {
		const { http, requests } = client([new Response(null, { status: 204 })]);
		await new AriChannels(http).hangup("abc", { causeCode: 17 });
		expect(requests[0]?.method).toBe("DELETE");
		expect(requests[0]?.url).toBe("http://asterisk:8088/ari/channels/abc?reason_code=17");
	});

	it("treats hanging up an already-gone channel as done, not as a failure", async () => {
		const { http } = client([new Response("", { status: 404 })]);
		await expect(new AriChannels(http).hangup("abc")).resolves.toBeUndefined();
	});

	it("resolves an unset channel variable to undefined", async () => {
		const { http } = client([
			new Response(JSON.stringify({ message: "not set" }), { status: 404 }),
		]);
		await expect(
			new AriChannels(http).getVariable("abc", "OPTIMIQ_ORG_ID"),
		).resolves.toBeUndefined();
	});

	it("reads a set channel variable", async () => {
		const { http } = client([new Response(JSON.stringify({ value: "org-1" }), { status: 200 })]);
		await expect(new AriChannels(http).getVariable("abc", "OPTIMIQ_ORG_ID")).resolves.toBe("org-1");
	});

	it("repeats the media parameter for a playlist", async () => {
		const { http, requests } = client([
			new Response(
				JSON.stringify({
					id: "pb",
					media_uri: "sound:a",
					target_uri: "channel:abc",
					state: "queued",
				}),
				{ status: 200 },
			),
		]);
		await new AriChannels(http).play("abc", { media: ["sound:a", "sound:b"], playbackId: "pb" });
		expect(requests[0]?.url).toContain("media=sound%3Aa&media=sound%3Ab");
		expect(requests[0]?.url).toContain("playbackId=pb");
	});

	it("puts originate variables in the body, where ARI actually reads them", async () => {
		const { http, requests } = client([new Response(JSON.stringify(CHANNEL), { status: 200 })]);
		await new AriChannels(http).originate({
			endpoint: "PJSIP/1001",
			app: "optimiq-engine",
			variables: { OPTIMIQ_ORG_ID: "org-1" },
		});
		expect(requests[0]?.body).toBe(JSON.stringify({ variables: { OPTIMIQ_ORG_ID: "org-1" } }));
		expect(requests[0]?.url).not.toContain("OPTIMIQ_ORG_ID");
	});
});
