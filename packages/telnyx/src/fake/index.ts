/**
 * `@optimiq-voice/telnyx/fake` — the in-package fake carrier.
 *
 * Behind its own subpath so importing the client root cannot pull a test double into a production
 * bundle. See `fake/server.ts` for what it is faithful about and what it is not.
 */

export { FAKE_BRAND_OTP_PIN, type FakeTelnyxServer, startFakeTelnyxServer } from "./server";
export {
	defaultInventory,
	type FakeAddress,
	type FakeAddressValidation,
	type FakeConnection,
	type FakeNumberInventoryEntry,
	type FakeBrand,
	type FakeCampaign,
	type FakeMessage,
	type FakeMessagingProfile,
	type FakeOrder,
	type FakePhoneNumberCampaign,
	type FakePortingOrder,
	type FakeProfile,
	FakeTelnyxState,
	type FakeTollFreeVerification,
} from "./state";
export {
	signFakeTelnyxWebhook,
	type FakeWebhookKeyPair,
	generateFakeWebhookKeyPair,
} from "./webhook-signer";
