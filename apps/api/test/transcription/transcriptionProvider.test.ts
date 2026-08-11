import { Readable } from "node:stream";
import { expect } from "chai";
import {
	createTranscriptionProvider,
	describeTranscriptionProvider,
	isRetryableStatus,
	isTranscriptionConfigured,
	loadTranscriptionEnv,
	OpenAiTranscriptionProvider,
	parseTranscriptionBody,
	readAudioWithLimit,
	selectTranscriptionDriver,
	TranscriptionFailure,
} from "../../src/transcription";
import type {
	TranscriptionAudio,
	TranscriptionEnv,
	TranscriptionFetch,
} from "../../src/transcription";

/**
 * The transcription seam, tested without a network and without an API key.
 *
 * Four things are worth testing here and this file is organised around them:
 *
 * 1. **The environment contract.** Which driver an environment gets, and which environments are
 *    REFUSED. The default has to stay `disabled` making zero external calls, because voicemail is a
 *    recording of a customer talking and a deployment that has not asked for it to be sent anywhere
 *    must not have it sent anywhere. Half-configured has to throw at boot, in both directions.
 * 2. **The `disabled` driver**, which is the one almost every deployment runs. Its whole job is to
 *    cost nothing and to be impossible to use by accident.
 * 3. **The `openai-compatible` driver**, against an in-process fake `fetch`. A hand-rolled fake
 *    rather than a mocking library, on exactly the argument `test/storage/objectStore.test.ts`
 *    records for its S3 stub: the assertions that matter are about the REQUEST this driver builds —
 *    the URL, the bearer header, the multipart field names — and matchers would hide those.
 * 4. **Failure classification**, which is the seam's real contract with the pipeline. `retryable`
 *    is decided here and nowhere else; a `401` that came back retryable would turn a typo in an API
 *    key into a spin.
 */

const CONFIGURED = {
	TRANSCRIBE_BASE_URL: "https://api.example.test/v1",
	TRANSCRIBE_API_KEY: "sk-test-key",
	TRANSCRIBE_MODEL: "whisper-1",
} satisfies NodeJS.ProcessEnv;

// ---------------------------------------------------------------------------------------------
// 1. The environment contract and driver selection
// ---------------------------------------------------------------------------------------------

describe("transcription environment", () => {
	it("defaults to disabled, so an environment that has never heard of this sends nothing", () => {
		const env = loadTranscriptionEnv({});
		expect(selectTranscriptionDriver(env)).to.equal("disabled");
		expect(isTranscriptionConfigured(env)).to.equal(false);
		expect(env.baseUrl).to.equal(undefined);
		expect(env.apiKey).to.equal(undefined);
	});

	it("selects the openai-compatible driver once a base URL and a model are present", () => {
		const env = loadTranscriptionEnv({ ...CONFIGURED });
		expect(selectTranscriptionDriver(env)).to.equal("openai-compatible");
		expect(isTranscriptionConfigured(env)).to.equal(true);
		expect(env.model).to.equal("whisper-1");
	});

	it("works with no API key at all, which is the point of `compatible`", () => {
		// A whisper.cpp or faster-whisper server on the deployment's own network has no auth, and
		// requiring a key would mean inventing one. This is the configuration that keeps a tenant's
		// call audio inside the building.
		const env = loadTranscriptionEnv({
			TRANSCRIBE_BASE_URL: "http://whisper:8080/v1",
			TRANSCRIBE_MODEL: "large-v3",
		});
		expect(selectTranscriptionDriver(env)).to.equal("openai-compatible");
		expect(env.apiKey).to.equal(undefined);
	});

	it("refuses a base URL with no model, because there is no cross-provider default", () => {
		expect(() =>
			loadTranscriptionEnv({ TRANSCRIBE_BASE_URL: "https://api.example.test/v1" }),
		).to.throw(/TRANSCRIBE_MODEL/u);
	});

	it("refuses a credential pointed at nothing, which is the half-config that actually happens", () => {
		// An operator pastes a key from a provider's console and never reads the line above it. This
		// is the direction that has to throw: they believe the feature is on.
		expect(() => loadTranscriptionEnv({ TRANSCRIBE_API_KEY: "sk-orphan" })).to.throw(
			/TRANSCRIBE_BASE_URL/u,
		);
	});

	it("refuses a model pointed at nothing too", () => {
		expect(() => loadTranscriptionEnv({ TRANSCRIBE_MODEL: "whisper-1" })).to.throw(
			/TRANSCRIBE_BASE_URL/u,
		);
	});

	it("treats an empty string as unset, because compose cannot express absence", () => {
		const env = loadTranscriptionEnv({
			TRANSCRIBE_BASE_URL: "",
			TRANSCRIBE_API_KEY: "  ",
			TRANSCRIBE_MODEL: "",
		});
		expect(selectTranscriptionDriver(env)).to.equal("disabled");
	});

	it("strips a trailing slash so the endpoint is never built with a double one", () => {
		const env = loadTranscriptionEnv({ ...CONFIGURED, TRANSCRIBE_BASE_URL: "https://x.test/v1//" });
		expect(env.baseUrl).to.equal("https://x.test/v1");
	});

	it("carries a bounded retry budget and a size cap by default", () => {
		const env = loadTranscriptionEnv({ ...CONFIGURED });
		expect(env.maxAttempts).to.equal(3);
		expect(env.retryBaseMs).to.equal(2_000);
		expect(env.maxBackoffMs).to.equal(30_000);
		// OpenAI's own documented limit, and the ceiling that stands between an unusually long
		// message and this process's heap.
		expect(env.maxBytes).to.equal(25 * 1_024 * 1_024);
		expect(env.queueLimit).to.equal(500);
	});

	it("refuses a backoff ceiling below the first backoff, which would cap it before it applied", () => {
		expect(() =>
			loadTranscriptionEnv({
				...CONFIGURED,
				TRANSCRIBE_RETRY_BASE_MS: "5000",
				TRANSCRIBE_MAX_BACKOFF_MS: "1000",
			}),
		).to.throw(/TRANSCRIBE_MAX_BACKOFF_MS/u);
	});

	it("rejects a malformed number at boot rather than at the first message", () => {
		expect(() => loadTranscriptionEnv({ ...CONFIGURED, TRANSCRIBE_MAX_ATTEMPTS: "500" })).to.throw(
			/Invalid transcription environment/u,
		);
	});
});

// ---------------------------------------------------------------------------------------------
// 2. The disabled driver
// ---------------------------------------------------------------------------------------------

describe("the disabled provider", () => {
	it("is what an unconfigured environment gets", () => {
		const provider = createTranscriptionProvider(loadTranscriptionEnv({}));
		expect(provider.driver).to.equal("disabled");
		expect(provider.enabled).to.equal(false);
	});

	it("throws rather than quietly answering nothing, so a missing `enabled` check is loud", () => {
		// A no-op return would mark every message `done` with an empty transcript, which is
		// indistinguishable in the database from a real transcription of silence.
		const provider = createTranscriptionProvider(loadTranscriptionEnv({}));
		return provider.transcribe(fakeAudio()).then(
			() => expect.fail("the disabled provider must not answer"),
			(error: unknown) => {
				expect(error).to.be.instanceOf(TranscriptionFailure);
				expect((error as TranscriptionFailure).retryable).to.equal(false);
			},
		);
	});

	it("names itself in the boot log without naming a credential", () => {
		const env = loadTranscriptionEnv({});
		const line = describeTranscriptionProvider(createTranscriptionProvider(env), env);
		expect(line).to.contain("disabled");
		expect(line).to.contain("TRANSCRIBE_BASE_URL");
	});

	it("names the endpoint and model in the boot log, and never the key", () => {
		const env = loadTranscriptionEnv({ ...CONFIGURED });
		const line = describeTranscriptionProvider(createTranscriptionProvider(env, neverCalled), env);
		expect(line).to.contain("https://api.example.test/v1/audio/transcriptions");
		expect(line).to.contain("whisper-1");
		expect(line).to.contain("api key set");
		expect(line).to.not.contain("sk-test-key");
	});
});

// ---------------------------------------------------------------------------------------------
// 3. The openai-compatible driver
// ---------------------------------------------------------------------------------------------

describe("the openai-compatible provider", () => {
	it("posts multipart to <base>/audio/transcriptions with a bearer token", async () => {
		const calls: RecordedCall[] = [];
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			recordingFetch(calls, { ok: true, status: 200, body: '{"text":"call me back"}' }),
		);

		const result = await provider.transcribe(fakeAudio({ bytes: Buffer.from("RIFFfake") }));

		expect(result.text).to.equal("call me back");
		expect(calls).to.have.length(1);
		const call = calls[0] as RecordedCall;
		expect(call.url).to.equal("https://api.example.test/v1/audio/transcriptions");
		expect(call.init.method).to.equal("POST");
		expect(call.init.headers.authorization).to.equal("Bearer sk-test-key");
		// Never set by hand: `fetch` writes it from the FormData, including the boundary it generated.
		expect(Object.keys(call.init.headers)).to.not.include("content-type");
		expect(call.init.body.get("model")).to.equal("whisper-1");
		expect(call.init.body.get("response_format")).to.equal("verbose_json");
	});

	it("sends no authorization header at all when there is no key", async () => {
		// `Authorization: Bearer ` is a malformed header rather than an absent one, and a local
		// whisper server rejects it.
		const calls: RecordedCall[] = [];
		const provider = new OpenAiTranscriptionProvider(
			env({ TRANSCRIBE_BASE_URL: "http://whisper:8080/v1", TRANSCRIBE_MODEL: "large-v3" }),
			recordingFetch(calls, { ok: true, status: 200, body: '{"text":"hi"}' }),
		);

		await provider.transcribe(fakeAudio());
		expect(Object.keys((calls[0] as RecordedCall).init.headers)).to.not.include("authorization");
	});

	it("names the file part after the object, because whisper servers dispatch on the extension", async () => {
		const calls: RecordedCall[] = [];
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			recordingFetch(calls, { ok: true, status: 200, body: '{"text":"x"}' }),
		);

		await provider.transcribe(fakeAudio({ objectKey: "org-1/call-2/msg-3.wav" }));
		const file = (calls[0] as RecordedCall).init.body.get("file");
		expect(file).to.be.instanceOf(File);
		expect((file as File).name).to.equal("msg-3.wav");
		expect((file as File).type).to.equal("audio/wav");
	});

	it("passes a language hint through when the deployment configured one", async () => {
		const calls: RecordedCall[] = [];
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED, TRANSCRIBE_LANGUAGE: "en" }),
			recordingFetch(calls, { ok: true, status: 200, body: '{"text":"x"}' }),
		);

		await provider.transcribe(fakeAudio());
		expect((calls[0] as RecordedCall).init.body.get("language")).to.equal("en");
	});

	it("sends no language field when none was configured, so the model detects", async () => {
		const calls: RecordedCall[] = [];
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			recordingFetch(calls, { ok: true, status: 200, body: '{"text":"x"}' }),
		);

		await provider.transcribe(fakeAudio());
		expect((calls[0] as RecordedCall).init.body.get("language")).to.equal(null);
	});

	it("reads language and duration out of a verbose_json answer", async () => {
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			stubFetch({
				ok: true,
				status: 200,
				body: '{"text":"hello","language":"english","duration":12.5}',
			}),
		);

		const result = await provider.transcribe(fakeAudio());
		expect(result.text).to.equal("hello");
		expect(result.language).to.equal("english");
		// Seconds on the wire, milliseconds in this system. Converted at the seam, never past it.
		expect(result.durationMs).to.equal(12_500);
	});

	it("refuses an object the stat already says is over the cap, without reading a byte", async () => {
		let opened = false;
		const provider = new OpenAiTranscriptionProvider(env({ ...CONFIGURED }), neverCalled);
		const audio: TranscriptionAudio = {
			...fakeAudio({ sizeBytes: 40 * 1_024 * 1_024 }),
			async open() {
				opened = true;
				return Readable.from([Buffer.alloc(0)]);
			},
		};

		await expectFailure(provider.transcribe(audio), { retryable: false, match: /MAX_BYTES/u });
		expect(opened).to.equal(false);
	});

	it("refuses mid-stream when the stat lied, because a stat is a claim about the past", async () => {
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED, TRANSCRIBE_MAX_BYTES: "1024" }),
			neverCalled,
		);
		const audio: TranscriptionAudio = {
			...fakeAudio({ sizeBytes: undefined }),
			async open() {
				return Readable.from([Buffer.alloc(4_096)]);
			},
		};

		await expectFailure(provider.transcribe(audio), { retryable: false, match: /MAX_BYTES/u });
	});

	it("re-opens the audio on every attempt, which is what makes the retry loop sound", async () => {
		// A port that took a `Readable` would work on the first attempt and hand the second an
		// exhausted stream — a failure that only shows up when a provider is already having a bad day.
		let opens = 0;
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			stubFetch({ ok: true, status: 200, body: '{"text":"x"}' }),
		);
		const audio: TranscriptionAudio = {
			...fakeAudio(),
			async open() {
				opens += 1;
				return Readable.from([Buffer.from("RIFF")]);
			},
		};

		await provider.transcribe(audio);
		await provider.transcribe(audio);
		expect(opens).to.equal(2);
	});
});

// ---------------------------------------------------------------------------------------------
// 4. Failure classification — the seam's real contract with the pipeline
// ---------------------------------------------------------------------------------------------

describe("transcription failure classification", () => {
	it("treats rate limiting and 5xx as transient", () => {
		for (const status of [408, 409, 429, 500, 502, 503, 504]) {
			expect(isRetryableStatus(status), `${status}`).to.equal(true);
		}
	});

	it("treats configuration as permanent, because a retry loop will not fix an API key", () => {
		for (const status of [400, 401, 403, 404, 413, 415, 422]) {
			expect(isRetryableStatus(status), `${status}`).to.equal(false);
		}
	});

	it("classifies a 401 body as permanent and quotes it, bounded", async () => {
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			stubFetch({ ok: false, status: 401, body: '{"error":{"message":"Incorrect API key"}}' }),
		);

		await expectFailure(provider.transcribe(fakeAudio()), {
			retryable: false,
			status: 401,
			match: /Incorrect API key/u,
		});
	});

	it("classifies a 429 as retryable", async () => {
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			stubFetch({ ok: false, status: 429, body: "slow down" }),
		);

		await expectFailure(provider.transcribe(fakeAudio()), { retryable: true, status: 429 });
	});

	it("classifies a transport failure as retryable", async () => {
		const provider = new OpenAiTranscriptionProvider(env({ ...CONFIGURED }), async () => {
			throw new Error("ECONNRESET");
		});

		await expectFailure(provider.transcribe(fakeAudio()), { retryable: true });
	});

	it("collapses an HTML error page into one line rather than a kilobyte of markup", async () => {
		const provider = new OpenAiTranscriptionProvider(
			env({ ...CONFIGURED }),
			stubFetch({
				ok: false,
				status: 502,
				body: `<html>\n  <body>${"x".repeat(2_000)}</body>\n</html>`,
			}),
		);

		let thrown: TranscriptionFailure | undefined;
		try {
			await provider.transcribe(fakeAudio());
		} catch (error) {
			thrown = error as TranscriptionFailure;
		}
		expect(thrown?.message).to.not.contain("\n");
		expect(thrown?.message.length).to.be.lessThan(500);
	});
});

describe("reading a transcription body", () => {
	it("reads the ordinary json shape", () => {
		expect(parseTranscriptionBody('{"text":"hello"}', "k").text).to.equal("hello");
	});

	it("accepts an EMPTY transcript, because silence transcribes to nothing", () => {
		// This is the case that makes `transcription_status` load-bearing: `done` with an empty
		// string is a real answer and must not be confused with "nobody tried".
		expect(parseTranscriptionBody('{"text":""}', "k").text).to.equal("");
	});

	it("accepts a bare text body from a server that ignored response_format", () => {
		expect(parseTranscriptionBody("just the words", "k").text).to.equal("just the words");
	});

	it("accepts a bare json string too", () => {
		expect(parseTranscriptionBody('"just the words"', "k").text).to.equal("just the words");
	});

	it("ignores a NaN duration rather than writing one", () => {
		const result = parseTranscriptionBody('{"text":"x","duration":null}', "k");
		expect(result.durationMs).to.equal(undefined);
	});

	it("reads a confidence where a compatible server sends one", () => {
		expect(parseTranscriptionBody('{"text":"x","confidence":0.94}', "k").confidence).to.equal(0.94);
	});

	it("refuses a 200 whose shape carries no text, rather than recording an empty transcript", () => {
		// An endpoint that answered 200 with a shape nothing here recognises is misconfigured, and
		// `done` with an empty string would bury that in a column forever.
		let thrown: TranscriptionFailure | undefined;
		try {
			parseTranscriptionBody('{"result":"hello"}', "k");
		} catch (error) {
			thrown = error as TranscriptionFailure;
		}
		expect(thrown).to.be.instanceOf(TranscriptionFailure);
		expect(thrown?.retryable).to.equal(false);
	});

	it("treats an empty body as transient — a truncated response, not a misconfiguration", () => {
		let thrown: TranscriptionFailure | undefined;
		try {
			parseTranscriptionBody("   ", "k");
		} catch (error) {
			thrown = error as TranscriptionFailure;
		}
		expect(thrown?.retryable).to.equal(true);
	});
});

describe("the audio size cap", () => {
	it("reads a stream that fits", async () => {
		const bytes = await readAudioWithLimit(Readable.from([Buffer.from("abc")]), 1_024);
		expect(bytes.toString()).to.equal("abc");
	});

	it("refuses permanently at the cap — the object is the size it is", async () => {
		let thrown: TranscriptionFailure | undefined;
		try {
			await readAudioWithLimit(Readable.from([Buffer.alloc(100), Buffer.alloc(100)]), 128);
		} catch (error) {
			thrown = error as TranscriptionFailure;
		}
		expect(thrown).to.be.instanceOf(TranscriptionFailure);
		expect(thrown?.retryable).to.equal(false);
	});
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface RecordedCall {
	readonly url: string;
	readonly init: {
		readonly method: string;
		readonly headers: Record<string, string>;
		readonly body: FormData;
	};
}

interface StubResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly body: string;
}

function env(source: NodeJS.ProcessEnv): TranscriptionEnv {
	return loadTranscriptionEnv(source);
}

function stubFetch(response: StubResponse): TranscriptionFetch {
	return async () => ({
		ok: response.ok,
		status: response.status,
		text: async () => response.body,
	});
}

function recordingFetch(into: RecordedCall[], response: StubResponse): TranscriptionFetch {
	return async (url, init) => {
		into.push({ url, init: { method: init.method, headers: init.headers, body: init.body } });
		return { ok: response.ok, status: response.status, text: async () => response.body };
	};
}

/** For the paths that must not reach the network at all. */
const neverCalled: TranscriptionFetch = async () => {
	throw new Error("fetch must not be called on this path");
};

function fakeAudio(
	overrides: {
		readonly objectKey?: string;
		readonly bytes?: Buffer;
		readonly sizeBytes?: number | undefined;
	} = {},
): TranscriptionAudio {
	const bytes = overrides.bytes ?? Buffer.from("RIFF....WAVE");
	return {
		objectKey: overrides.objectKey ?? "org-1/box-1/message.wav",
		sizeBytes: "sizeBytes" in overrides ? overrides.sizeBytes : bytes.length,
		contentType: "audio/wav",
		languageHint: undefined,
		async open() {
			return Readable.from([bytes]);
		},
	};
}

async function expectFailure(
	promise: Promise<unknown>,
	expected: {
		readonly retryable: boolean;
		readonly status?: number;
		readonly match?: RegExp;
	},
): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(thrown, "expected a TranscriptionFailure").to.be.instanceOf(TranscriptionFailure);
	const failure = thrown as TranscriptionFailure;
	expect(failure.retryable, "retryable").to.equal(expected.retryable);
	if (expected.status !== undefined) {
		expect(failure.status).to.equal(expected.status);
	}
	if (expected.match !== undefined) {
		expect(failure.message).to.match(expected.match);
	}
}
