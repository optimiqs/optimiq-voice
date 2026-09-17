import { HttpException, HttpStatus } from "@nestjs/common";
import type { MediaResponse } from "./media-response";
import type { Readable } from "node:stream";

/**
 * The controller half of a media route.
 *
 * Three routes in this API now stream audio with range support — call recordings, voicemail
 * messages and the media library, the last of which is two routes because prompts and greetings are
 * different tables. Each one's handler is the same six lines: set every header the response
 * carries, throw on `416` (which has no body), set the status, return the stream. Six lines copied
 * five times is five chances for one of them to forget `content-range`.
 *
 * ## Why this lives beside `http-range.ts` rather than in one of the two areas
 *
 * The CDR area and the PBX area each own media routes, and both now use this. Putting it in either
 * one would make the other import an area it has no other business with — the same argument
 * `http-range.ts` makes about itself, and the reason `src/media/` exists at all.
 *
 * ## The Fastify types are declared structurally, and always have been here
 *
 * `recordings.controller.ts` states the reason: `fastify` arrives in `apps/api` transitively under
 * `@nestjs/platform-fastify`, and adding it as a DIRECT dependency in order to name
 * `FastifyRequest` in one signature would be a dependency taken on for a type import. So the two
 * interfaces below name the only members these routes touch — one method on the reply, one bag on
 * the request — and nothing else.
 */

/** The two methods of the Fastify reply a media route uses. */
export interface MediaReply {
	header(name: string, value: string): unknown;
	status(code: number): unknown;
}

/** The properties of the Fastify request a media route reads. */
export interface MediaRequest {
	readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
	/**
	 * Fastify's resolved client address.
	 *
	 * Declared optional because the interface above is structural by design (see the header) and
	 * every existing caller — the specs included — constructs a bare `{ headers }`. It is read only
	 * to attribute an ANONYMOUS media fetch in the audit ledger, where an absent address is a
	 * NULL rather than a failure.
	 */
	readonly ip?: string | undefined;
}

/** What an audit row can honestly say about the party behind an anonymous media fetch. */
export interface MediaClient {
	readonly ipAddress: string | undefined;
	readonly userAgent: string | undefined;
}

/**
 * The two identifying facts a signed-token media request actually carries.
 *
 * A signed link is followed without a session — that is the whole point of the scheme — so the
 * address and the user-agent are the ONLY things that distinguish one fetch of a leaked URL from
 * another. `request.ip` is preferred over the header because Fastify has already applied the
 * deployment's `trustProxy` configuration to it, and a raw `x-forwarded-for` is attacker-controlled
 * in a deployment that has not; the header is read only as the fallback for a request object that
 * did not resolve one, and only its FIRST entry, which is the closest thing to a client address the
 * chain contains.
 */
export function readMediaClient(request: MediaRequest): MediaClient {
	const forwarded = request.headers?.["x-forwarded-for"];
	const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
	const agent = request.headers?.["user-agent"];
	return {
		ipAddress: request.ip ?? header?.split(",")[0]?.trim(),
		userAgent: Array.isArray(agent) ? agent[0] : agent,
	};
}

/**
 * The `Range` header, however the platform spells it.
 *
 * Node lower-cases incoming header names, so `headers.range` is the whole story in practice; the
 * capitalised fallback costs one property read and removes a class of "it works behind one proxy
 * and not another" bug. An array (which a duplicated header produces) takes the first value —
 * RFC 9110 says a repeated `Range` is invalid, and `decideRange` will answer `"full"` for anything
 * it cannot parse, so the worst case is a whole-object response rather than a wrong one.
 */
export function readRangeHeader(request: MediaRequest): string | undefined {
	const value = request.headers?.range ?? request.headers?.Range;
	if (Array.isArray(value)) {
		return value[0];
	}
	return typeof value === "string" ? value : undefined;
}

/**
 * The `416` body.
 *
 * Declared here rather than in either area's error module because it is thrown from exactly one
 * place — {@link applyMediaResponse} — and both areas answer with it. The shape matches the rest of
 * the platform's errors (`statusCode`, a `code` a client can switch on, a sentence) so
 * `apps/web`'s error reader needs no special case.
 */
export class MediaRangeNotSatisfiableException extends HttpException {
	constructor(sizeBytes: number) {
		super(
			{
				statusCode: HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
				code: "MEDIA_RANGE_NOT_SATISFIABLE",
				message: `The requested range is outside this object, which is ${String(sizeBytes)} bytes.`,
				sizeBytes,
			},
			HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
		);
	}
}

/**
 * Applies a {@link MediaResponse} to a reply and returns the body to hand back to Nest.
 *
 * @throws {MediaRangeNotSatisfiableException} for `416`, which is the one outcome with no body.
 *   The `content-range: bytes * /<size>` header is set BEFORE the throw — it is the only thing that
 *   tells a seeking player how big the object really is, and a client that gets a bare 416 can only
 *   retry the same bad range — and the exception carries the same number in its JSON body for a
 *   caller that reads one.
 */
export function applyMediaResponse(reply: MediaReply, response: MediaResponse): Readable {
	for (const [name, value] of Object.entries(response.headers)) {
		void reply.header(name, value);
	}
	if (response.stream === undefined) {
		throw new MediaRangeNotSatisfiableException(response.sizeBytes);
	}
	void reply.status(response.status);
	return response.stream;
}
