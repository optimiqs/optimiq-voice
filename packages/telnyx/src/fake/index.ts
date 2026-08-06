/**
 * `@optimiq-voice/telnyx/fake` — the in-package fake carrier.
 *
 * Behind its own subpath so importing the client root cannot pull a test double into a production
 * bundle. See `fake/server.ts` for what it is faithful about and what it is not.
 */

export { type FakeTelnyxServer, startFakeTelnyxServer } from "./server";
export {
	defaultInventory,
	type FakeConnection,
	type FakeNumberInventoryEntry,
	type FakeOrder,
	type FakeProfile,
	FakeTelnyxState,
} from "./state";
export {
	signFakeTelnyxWebhook,
	type FakeWebhookKeyPair,
	generateFakeWebhookKeyPair,
} from "./webhook-signer";
