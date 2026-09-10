import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * The erasure surface's HTTP failure taxonomy.
 *
 * Its own file rather than a pair of entries in `shared/cdr.errors.ts`, on the shape
 * `pbx/calls/call-recording.errors.ts` established: an area-wide taxonomy is for failures every
 * route in the area can raise, and these two are properties of ONE endpoint's body. Keeping them
 * beside the endpoint is what lets the doc comment argue the decision rather than restate the
 * status code.
 *
 * ```jsonc
 * { "statusCode": 400, "code": "CDR_ERASURE_SELECTOR", "message": "…", "supplied": ["phoneNumber","extension"] }
 * ```
 */

/**
 * The body named both selectors, or neither.
 *
 * A 400 and not a "pick one for you", which is the whole reason this is refused rather than
 * resolved. An erasure request is irreversible and its blast radius is decided entirely by the
 * selector: `{ phoneNumber, extension }` together could plausibly mean the intersection (erase what
 * this number left in this mailbox) or the union (erase both), and the two differ by however many
 * recordings the rest of the extension holds. Nothing in the request says which was meant, so
 * neither is assumed — an operator who wants both runs the endpoint twice and sees two previews.
 *
 * Neither selector is refused for the mirror-image reason: an empty body is a request to erase
 * nothing, and answering it with a cheerful set of zeroes would be indistinguishable from "this
 * person has no data here" to the client that got the selector name wrong.
 */
export class CdrErasureSelectorException extends HttpException {
	constructor(supplied: readonly string[]) {
		super(
			{
				statusCode: HttpStatus.BAD_REQUEST,
				code: "CDR_ERASURE_SELECTOR",
				message:
					supplied.length === 0
						? "An erasure request must name exactly one of `phoneNumber` or `extension`; it named neither."
						: "An erasure request must name exactly one of `phoneNumber` or `extension`; it named both. Run it once per subject so each has its own preview.",
				supplied,
			},
			HttpStatus.BAD_REQUEST,
		);
	}
}
