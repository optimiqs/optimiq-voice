/**
 * The auto-answer signal: what the engine puts on an intercom or paging INVITE, and what the five
 * desk-phone templates are configured to honour.
 *
 * ## Why this is a constant and not a string in six files
 *
 * Auto-answer is the only feature in this catalogue where the phone's configuration and the SWITCH's
 * behaviour have to agree on a literal. Everything else a template writes is self-contained — a
 * transport code, a key type, a credential — and is wrong only if the template is wrong. This one is
 * a handshake: the engine sends a header, the phone matches a string, and if the two strings differ
 * by a character the phone rings normally and nobody finds out until somebody pages the warehouse
 * and forty handsets sit there chirping. So the literal has one owner, and the templates and the
 * originator agree by construction rather than by coincidence.
 *
 * ## The token, and why this one
 *
 * `info=alert-autoanswer`. The instruction that produced this file offered it as the default and
 * asked for a different one if the five templates said a different one travels further; they say the
 * opposite, and here is the count.
 *
 * - **Yealink** documents this exact token. Its intercom feature answers an INVITE whose `Alert-Info`
 *   carries `info=alert-autoanswer`, and no other string is documented for it.
 * - **Snom** documents this exact token too, in the fuller form its examples show —
 *   `Alert-Info: <http://www.notused.com>;info=alert-autoanswer;delay=0`. The URI is decorative
 *   (Snom's own example says "not used"); the `info=` parameter is the part that is matched.
 * - **Poly** matches the Alert-Info field against a string the ADMINISTRATOR chooses
 *   (`voIpProt.SIP.alertInfo.x.value`), so it honours whatever we tell it to. It costs nothing to
 *   point it at the same token as the other two, and it costs a debugging session to give it
 *   `Ring Answer` because a forum post used that.
 * - **Fanvil** has an intercom feature and no documentation we could read about what triggers it
 *   from the wire. See its template.
 * - **Grandstream** is the one that cannot honour this token at all, at any spelling, because it does
 *   not match on `Alert-Info`: its feature is "Allow Auto Answer by **Call-Info**" and what it looks
 *   for is `answer-after=`. That is a header difference, not a token difference, so no choice of
 *   token could have unified the five. See {@link AUTO_ANSWER_CALL_INFO}.
 *
 * Three of five honour it, one is configured to, one needs a different header. `Ring Answer` and
 * `Auto Answer` — the two strings a search turns up most often — are Polycom-community conventions
 * that Yealink and Snom do not document at all, so choosing either would trade two documented
 * vendors for one configurable one.
 *
 * ## The five vendors, side by side
 *
 * | Vendor | Header it matches | Parameter(s) the template writes | Separate enable? | Verified? |
 * |---|---|---|---|---|
 * | Yealink | `Alert-Info`, token documented | `features.intercom.allow` / `.tone` / `.mute` / `.barge` | yes — `allow` is the enable, `barge` is the interrupt-a-call flag | parameter names and token both documented |
 * | Snom | `Alert-Info`, token documented | `answer_after_policy`, `auto_connect_indication` | yes — the policy IS the enable, and it defaults to `off` since firmware 7.1.39 | parameter names, values and token all documented |
 * | Poly | `Alert-Info`, token is OURS to choose | `voIpProt.SIP.alertInfo.1.value` / `.class` | no flag; the mapping to the `ringAutoAnswer` ring class is the whole feature | parameters documented; whether `.value` matches exactly or as a substring is NOT |
 * | Grandstream | **`Call-Info`**, `answer-after=` | `P298`, `P2356` | yes — `P298` is the enable, off by default | the P-names and semantics are corroborated; their ALIAS names are not |
 * | Fanvil | unknown | `Enable Intercom` / `Intercom Tone` / `Intercom Mute` / `Intercom Barge` | yes — `Enable Intercom` is the enable, `Intercom Barge` the interrupt flag | the parameter names are derived from the XML dialect by this file's own mapping; the wire trigger is NOT documented anywhere readable |
 *
 * Read across the row that matters most: **three vendors need an enable flag that is off or
 * unreliable by default**, so a deployment that sent the header and configured nothing would page
 * nobody. And two of the five could not be fully verified — Grandstream's alias names and Fanvil's
 * trigger — which is recorded in those templates' `caveats` in the register `fanvil.ts` established
 * for the TLS transport integer: say UNVERIFIED, write the corroborated half, and name the
 * experiment that would settle it.
 *
 * ## What this is NOT
 *
 * It is not a security boundary. A header on an INVITE is a request to the handset, honoured because
 * the handset was configured to honour it, and any device that can reach the SIP edge can send one.
 * What stops a stranger opening a microphone in somebody's office is that the INVITE has to
 * authenticate and route first — the same gate every other call goes through. The templates below
 * deliberately keep the audible indication ON for exactly this reason: a phone that answers silently
 * is a phone whose owner cannot tell that it did.
 */

/**
 * The `Alert-Info` field value the engine sends on an intercom or paging origination, and the string
 * the Yealink, Poly and Snom templates are configured to match.
 *
 * Sent bare rather than wrapped in the `<http://…>` URI Snom's example shows: RFC 3261 allows the
 * `Alert-Info` header to carry parameters without a URI, Yealink's documented form has no URI, and
 * Snom matches on the `info=` parameter rather than on the URI it is hanging off. A URI here would be
 * a decorative token that one vendor's parser might insist on and another's might trip over, added
 * for no behaviour.
 */
export const AUTO_ANSWER_ALERT_INFO = "info=alert-autoanswer";

/**
 * Grandstream's half of the handshake, and the reason it needs one.
 *
 * Grandstream is the only vendor of the five whose auto-answer feature does not read `Alert-Info`.
 * Its setting is "Allow Auto Answer by Call-Info" and the parameter it looks for is `answer-after=`
 * on a `Call-Info` header — the Broadsoft/Cisco convention rather than the Yealink/Snom one. A
 * deployment with Grandstream handsets therefore needs the originator to send BOTH headers, which
 * costs nothing (a phone ignores the header it was not configured for) and is the only arrangement
 * that pages all five vendors from one origination.
 *
 * Exported beside {@link AUTO_ANSWER_ALERT_INFO} rather than folded into it because they are not
 * interchangeable spellings of one thing: they are two headers, and a caller that sent this one as
 * `Alert-Info` would produce a phone that does nothing on four vendors and a phone that does nothing
 * on the fifth.
 *
 * The value is the PARAMETER only. `Call-Info` requires a URI before it, and that URI is the
 * switch's own address — which this module does not know and must not guess. The originator
 * composes `<sip:${sipDomain}>;${AUTO_ANSWER_CALL_INFO}`.
 */
export const AUTO_ANSWER_CALL_INFO = "answer-after=0";
