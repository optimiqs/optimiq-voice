import { AriHttpError, AriResponseShapeError, AriTransportError } from "./errors";
import { basicAuthHeader, buildRestUrl } from "./url";
import type { AriCredentials, QueryValue } from "./url";
import type { z } from "zod";

/**
 * The ARI REST transport: one `fetch` call, basic auth, and the error mapping.
 *
 * Deliberately plain `fetch` (Node ≥22 global, and Bun's) rather than a client library. ARI is a
 * small, versioned REST surface; the value this file adds is not "HTTP", it is turning Asterisk's
 * three failure shapes into one typed error and refusing to hand back an unvalidated body.
 */

/** Query parameters as the resource methods express them. */
export type AriQuery = Readonly<Record<string, QueryValue | readonly QueryValue[]>>;

/**
 * The slice of `fetch` this adapter uses.
 *
 * Narrower than `typeof globalThis.fetch` on purpose: that type differs between Node's and Bun's
 * lib definitions (Bun adds `preconnect`), and requiring the full shape would mean every test
 * double had to implement properties nothing here calls.
 */
export type AriFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Everything the transport needs. */
export interface AriHttpClientOptions {
	/** Already normalised by `normalizeAriBaseUrl`. */
	readonly baseUrl: string;
	readonly credentials: AriCredentials;
	/** Per-request timeout. Defaults to 10s — an ARI call that takes longer has failed. */
	readonly timeoutMs?: number;
	/** Injection seam for tests; defaults to the global `fetch`. */
	readonly fetch?: AriFetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

interface RequestInput {
	readonly method: "GET" | "POST" | "DELETE" | "PUT";
	readonly path: string;
	readonly query?: AriQuery;
	readonly body?: unknown;
	/** Signals that a 404 is an expected outcome and should resolve to `undefined`. */
	readonly tolerateNotFound?: boolean;
}

/** Extracts ARI's `{"message": "..."}` error body without letting a bad body mask the status. */
function asteriskMessageOf(body: string): string | undefined {
	if (body === "") {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(body);
		if (typeof parsed === "object" && parsed !== null && "message" in parsed) {
			const message = (parsed as { message: unknown }).message;
			return typeof message === "string" ? message : undefined;
		}
	} catch {
		// A non-JSON error body (Asterisk's HTTP layer answers some failures in plain text) is
		// still useful, just not as a structured message. It survives on `AriHttpError.body`.
	}
	return undefined;
}

export class AriHttpClient {
	private readonly baseUrl: string;
	private readonly authorization: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: AriFetch;

	constructor(options: AriHttpClientOptions) {
		this.baseUrl = options.baseUrl;
		this.authorization = basicAuthHeader(options.credentials);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	}

	/**
	 * Issues a request and returns the raw response body text, or `undefined` for `204` and for a
	 * tolerated `404`.
	 *
	 * @throws {AriHttpError} on any other non-2xx status.
	 * @throws {AriTransportError} when the request never got an answer.
	 */
	async requestText(input: RequestInput): Promise<string | undefined> {
		const url = buildRestUrl(this.baseUrl, input.path, input.query ?? {});
		const controller = new AbortController();
		const timer = setTimeout(() => {
			controller.abort();
		}, this.timeoutMs);

		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method: input.method,
				headers: {
					authorization: this.authorization,
					accept: "application/json",
					...(input.body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: input.body === undefined ? undefined : JSON.stringify(input.body),
				signal: controller.signal,
			});
		} catch (cause) {
			throw new AriTransportError(input.method, input.path, { cause });
		} finally {
			clearTimeout(timer);
		}

		if (response.status === 204) {
			return undefined;
		}

		const text = await response.text();

		if (!response.ok) {
			if (response.status === 404 && input.tolerateNotFound === true) {
				return undefined;
			}
			throw new AriHttpError({
				status: response.status,
				method: input.method,
				path: input.path,
				asteriskMessage: asteriskMessageOf(text),
				body: text === "" ? undefined : text.slice(0, 2000),
			});
		}

		return text;
	}

	/** A request whose response body is discarded (`answer`, `hangup`, `ring`, …). */
	async requestVoid(input: RequestInput): Promise<void> {
		await this.requestText(input);
	}

	/**
	 * A request whose response is validated against `schema`.
	 *
	 * @throws {AriResponseShapeError} when Asterisk answered 2xx with a body the schema rejects.
	 */
	async requestParsed<TSchema extends z.ZodType>(
		input: RequestInput,
		schema: TSchema,
	): Promise<z.infer<TSchema>> {
		const text = await this.requestText(input);
		const parsed = this.decodeJson(input, text ?? "");
		const result = schema.safeParse(parsed);
		if (!result.success) {
			throw new AriResponseShapeError(
				input.method,
				input.path,
				result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
			);
		}
		return result.data as z.infer<TSchema>;
	}

	/**
	 * As {@link requestParsed}, but a tolerated `404` resolves to `undefined` instead of throwing.
	 * This is the "read a resource that may already be gone" shape (`getChannel` during teardown).
	 */
	async requestParsedOptional<TSchema extends z.ZodType>(
		input: RequestInput,
		schema: TSchema,
	): Promise<z.infer<TSchema> | undefined> {
		const text = await this.requestText({ ...input, tolerateNotFound: true });
		if (text === undefined) {
			return undefined;
		}
		const result = schema.safeParse(this.decodeJson(input, text));
		if (!result.success) {
			throw new AriResponseShapeError(
				input.method,
				input.path,
				result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
			);
		}
		return result.data as z.infer<TSchema>;
	}

	private decodeJson(input: RequestInput, text: string): unknown {
		if (text === "") {
			return undefined;
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new AriResponseShapeError(input.method, input.path, ["body is not valid JSON"]);
		}
	}
}
