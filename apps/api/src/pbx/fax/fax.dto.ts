import { z } from "zod/v4";
import { listQuerySchema } from "../shared/pagination";

/**
 * Fax DTOs. `z.strictObject` everywhere, like the rest of the PBX area — an unknown key is a client
 * that thinks it is setting something, and dropping it silently is how "I set that and it did
 * nothing" bugs are born.
 */

/** E.164, the one shape every number in this platform is stored and compared in. */
const e164 = z
	.string()
	.trim()
	.regex(/^\+[1-9]\d{1,14}$/u, "must be an E.164 number such as +13125551234");

const optionalEmail = z.email().max(320).optional();

export const createFaxServerDto = z.strictObject({
	name: z.string().trim().min(1).max(128),
	extensionNumber: z.string().trim().min(1).max(32).optional(),
	phoneNumberId: z.uuid().optional(),
	headerText: z.string().trim().max(128).optional(),
	emailToAddress: optionalEmail,
	emailFromAddress: optionalEmail,
	retryAttempts: z.coerce.number().int().min(0).max(10).optional(),
	retryBackoffSeconds: z.coerce.number().int().min(1).max(86_400).optional(),
	enabled: z.boolean().optional(),
});

export type CreateFaxServerDto = z.infer<typeof createFaxServerDto>;

/** Every field optional, and `phoneNumberId`/`extensionNumber` explicitly nullable to unbind. */
export const updateFaxServerDto = z.strictObject({
	name: z.string().trim().min(1).max(128).optional(),
	extensionNumber: z.string().trim().min(1).max(32).nullable().optional(),
	phoneNumberId: z.uuid().nullable().optional(),
	headerText: z.string().trim().max(128).nullable().optional(),
	emailToAddress: z.email().max(320).nullable().optional(),
	emailFromAddress: z.email().max(320).nullable().optional(),
	retryAttempts: z.coerce.number().int().min(0).max(10).optional(),
	retryBackoffSeconds: z.coerce.number().int().min(1).max(86_400).optional(),
	enabled: z.boolean().optional(),
});

export type UpdateFaxServerDto = z.infer<typeof updateFaxServerDto>;

/**
 * Queue an outbound fax.
 *
 * `mediaUrl` is a URL the carrier fetches the document from — it must be reachable by Telnyx. The
 * send stores this URL rather than downloading it, so the worker hands the carrier a `media_url`
 * without needing a presign-capable object store. (Telnyx Media Storage — sending by `media_name` —
 * is a separate carrier feature and out of scope this wave; the carrier client supports it, the API
 * does not yet.)
 */
export const sendFaxDto = z.strictObject({
	to: e164,
	mediaUrl: z.url().max(2_048),
});

export type SendFaxDto = z.infer<typeof sendFaxDto>;

/** List filters for the inbox/outbox. Direction, status and server narrow; the base pages. */
export const faxMessageListQuerySchema = listQuerySchema.extend({
	/** Restrict to one fax server's inbox/outbox. */
	serverId: z.uuid().optional(),
	direction: z.enum(["inbound", "outbound"]).optional(),
	status: z.enum(["queued", "sending", "delivered", "failed", "receiving", "received"]).optional(),
});

export type FaxMessageListQuery = z.infer<typeof faxMessageListQuerySchema>;

export const faxServerListQuerySchema = listQuerySchema;
export type FaxServerListQuery = z.infer<typeof faxServerListQuerySchema>;
