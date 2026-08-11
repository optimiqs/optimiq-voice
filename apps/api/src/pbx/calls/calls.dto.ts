import { z } from "zod/v4";

/**
 * `POST /api/v1/calls` — the click-to-dial button.
 *
 * ## Two fields, and what they mean
 *
 * `from` is an extension NUMBER in this organization — `1001`, not an extension row id. It is the
 * number rather than the id because the caller of this endpoint is a CRM, a browser extension or a
 * dial button, and the thing all three have in hand is what the user's phone is called. Accepting an
 * id would mean every integrator maintaining a mapping this platform already has.
 *
 * `to` is whatever the extension would have typed on the handset: another extension, a feature code,
 * an E.164 number. It is resolved by the engine against the tenant's own dial plan, IN THE
 * EXTENSION'S NAME, so a click-to-call can never reach a destination its user could not have dialled.
 *
 * ## What is NOT here
 *
 * There is no `organizationId`. It comes from the session, on the same terms as every other route in
 * this area (oikos §4: no controller accepts a tenant from a caller). There is no channel or call id
 * either — the API mints the origination handle itself, because a caller-supplied one would let two
 * tenants collide on a media channel id.
 */
export const originateCallDto = z.strictObject({
	/** The extension to ring first. Its own number, as dialled internally. */
	from: z
		.string()
		.trim()
		.min(1)
		.max(32)
		.regex(/^[0-9*#+]+$/u, "from must be an extension number"),
	/** What that extension is dialling. Validated by the tenant's plan, not by a pattern here. */
	to: z.string().trim().min(1).max(128),
	/**
	 * How long to ring the extension before giving up.
	 *
	 * Bounded by the contract (`5..300`), and left to the engine's default when absent. A dial button
	 * that could ask for an unbounded ring would be a way to hold a channel and a media session
	 * indefinitely with one request.
	 */
	ringTimeoutSeconds: z.int().min(5).max(300).optional(),
	/**
	 * Caller ID to present to the destination, when the tenant wants something other than the
	 * extension's own.
	 *
	 * Advisory: the outbound routing may still override it, exactly as it does for a call the user
	 * dialled by hand. Accepting it here does not bypass the tenant's CLI policy, and the contract
	 * says so on the engine's side too.
	 */
	callerIdNumber: z.string().trim().max(128).optional(),
	callerIdName: z.string().trim().max(128).optional(),
});
