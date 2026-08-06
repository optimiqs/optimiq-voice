import {
	Controller,
	Get,
	Header,
	Headers,
	Inject,
	Param,
	Req,
	Res,
	UseFilters,
} from "@nestjs/common";
import { PublicRoute } from "../../auth/public-route.decorator";
import { ProvisionRateLimitFilter } from "./provision-rate-limit.filter";
import { ProvisionService } from "./provision.service";
import type { ProvisionRequest } from "./provision.service";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * `GET /provision/:token/config` and `GET /provision/:token/payload`.
 *
 * ## Why this is `@PublicRoute()`, and what stands in the guard's place
 *
 * A desk phone has no session, no cookie and no organization. It has a URL, which was typed into it
 * by an administrator or pushed to it by DHCP option 66. So the global `RequirePermissionsGuard`
 * cannot help here and the route opts out of it explicitly — the same shape, and the same
 * obligation to justify it, as `carrier-webhook.controller.ts`.
 *
 * What replaces it is in `provision.service.ts`: a two-part token whose secret half is verified
 * against a SHA-256 at rest in constant time, an expiry, a per-device rate limit, a device/tenant
 * state check, and an optional per-organization source-address allowlist. FusionPBX's equivalent
 * endpoint had **none** of those — `plans/reference/fusionpbx-inventory.md` §7 lists it first among
 * the upstream's highest-risk items — and every one of them is here because of that.
 *
 * ## Why the path is not under `/api/v1`
 *
 * Because a phone's provisioning URL is typed by a human into a four-line LCD, or read aloud over a
 * phone call, or entered on a handset's own keypad. `/provision/<token>/config` is as short as it
 * can be while still being unambiguous, and it also keeps the surface that has no session visibly
 * separate from the one that does — a route audit can grep for it.
 *
 * ## Caching
 *
 * `Cache-Control: no-store` on both routes. A configuration contains a SIP password, and a phone
 * that is behind a caching proxy on a shared network must not have it served to the next device
 * that asks. The same header is why a rotated token takes effect immediately rather than whenever
 * an intermediary decides to revalidate.
 */
@Controller("provision")
@UseFilters(ProvisionRateLimitFilter)
export class ProvisionController {
	constructor(@Inject(ProvisionService) private readonly provisioning: ProvisionService) {}

	/**
	 * The vendor-format configuration file.
	 *
	 * The body is written through the raw reply because the `Content-Type` and the filename are the
	 * template's to decide — a Yealink gets `text/plain` and a Grandstream `application/xml`, and
	 * several vendors' firmware is documented as sensitive to it. Nest's default JSON serialization
	 * would wrap the file in quotes and escape every newline, which is a config no phone can read.
	 */
	@Get(":token/config")
	@PublicRoute()
	@Header("Cache-Control", "no-store")
	async config(
		@Param("token") token: string,
		@Req() request: FastifyRequest,
		@Res() reply: FastifyReply,
		@Headers("user-agent") userAgent?: string,
	): Promise<void> {
		const context = describeRequest(token, request, userAgent);
		const result = await this.provisioning.renderConfig(context);
		const body = result.value.body;

		await reply
			.status(200)
			.header("content-type", result.value.contentType)
			.header("cache-control", "no-store")
			// Not an attachment: a phone streams the body and a support engineer opening the URL in a
			// browser wants to READ it, not download it. The filename is advisory and is here because
			// several vendors log the name they were served.
			.header("content-disposition", `inline; filename="${result.value.filename}"`)
			.send(body);

		// After the response, deliberately. The configuration is already on its way, so an audit
		// write that fails must not turn into a phone that did not provision — see
		// `ProvisionService.recordRender`.
		await this.provisioning.recordRender(
			context,
			result.context,
			result.templateId,
			Buffer.byteLength(body, "utf8"),
		);
	}

	/**
	 * The structured account payload — what a softphone consumes and what a QR code encodes.
	 *
	 * JSON, so it goes back through Nest's serializer like every other JSON route in the app.
	 */
	@Get(":token/payload")
	@PublicRoute()
	@Header("Cache-Control", "no-store")
	async payload(
		@Param("token") token: string,
		@Req() request: FastifyRequest,
		@Headers("user-agent") userAgent?: string,
	) {
		const context = describeRequest(token, request, userAgent);
		const result = await this.provisioning.renderPayload(context);
		await this.provisioning.recordRender(
			context,
			result.context,
			result.templateId,
			Buffer.byteLength(JSON.stringify(result.value), "utf8"),
		);
		return { data: result.value };
	}
}

/**
 * What the events and the ACL check need to know about the caller.
 *
 * ## `X-Forwarded-For` is deliberately NOT consulted
 *
 * The source address is the transport peer and nothing else. A forwarded header is written by
 * whoever spoke to us last and, on a public endpoint with no session, by anyone who wants to. If
 * this trusted it, an organization's provisioning IP allowlist would be bypassable by adding one
 * header — turning the control into decoration while leaving it looking like protection, which is
 * worse than not having it.
 *
 * A deployment that genuinely terminates TLS at a proxy therefore has to make the proxy preserve
 * the client address (PROXY protocol, or Fastify's `trustProxy` set to the proxy's own address,
 * which is a deliberate operator decision rather than a default). That is recorded as a follow-up;
 * it is not something this file may decide unilaterally.
 */
function describeRequest(
	token: string,
	request: FastifyRequest,
	userAgent: string | undefined,
): ProvisionRequest {
	const socket = request.raw.socket;
	const ip = socket.remoteAddress ?? undefined;
	const port = socket.remotePort;
	return {
		token,
		sourceAddress: ip === undefined ? "unknown" : `${ip}:${port ?? 0}`,
		sourceIp: normalizeIp(ip),
		// Recorded verbatim for forensics, capped so a pathological URL cannot fill the event.
		path: request.url.slice(0, 512),
		userAgent: userAgent?.slice(0, 256),
	};
}

/**
 * `::ffff:203.0.113.4` -> `203.0.113.4`.
 *
 * Node reports a v4 client on a dual-stack listener as a v4-mapped v6 address. Postgres's `inet`
 * type accepts that form and its `<<=` operator does NOT consider it contained by a v4 CIDR, so an
 * allowlist written as `203.0.113.0/24` would refuse the very host it names. Unmapping here is what
 * makes an ACL an administrator writes behave the way they expect.
 */
function normalizeIp(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const mapped = /^::ffff:(?<v4>\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(value);
	return mapped?.groups?.v4 ?? value;
}
