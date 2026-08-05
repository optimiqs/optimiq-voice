import { CommonTypes as CT } from "@routr/common";
import routrSdk from "@routr/sdk";
import { CreatePeerRequest } from "@routr/sdk/dist/peers/types";
import { getLogger } from "@optimiq-voice/logger";
import {
	ROUTR_DEFAULT_PEER_AOR,
	ROUTR_DEFAULT_PEER_NAME,
	ROUTR_DEFAULT_PEER_PASSWORD,
	ROUTR_DEFAULT_PEER_USERNAME,
} from "../envs";
import { routrConfig } from "./routrConfig";

/**
 * `@routr/sdk` is CommonJS whose `module.exports` is `{ default: { Peers, Credentials, … } }`.
 *
 * Under the old CommonJS build `esModuleInterop` unwrapped that for us, because the package sets
 * `__esModule: true`. Node's ES-module interop ignores `__esModule` and always binds `default` to
 * `module.exports` itself, so the constructors sit one level deeper at runtime while TypeScript
 * still types `routrSdk` as the inner object. Unwrap explicitly, tolerating both shapes.
 */
const SDK = ((routrSdk as { default?: typeof routrSdk }).default ?? routrSdk) as typeof routrSdk;

const logger = getLogger({ service: "api", filePath: import.meta.filename });

function createCredentialsForDefaultPeer() {
	const credentials = new SDK.Credentials(routrConfig);

	const request = {
		name: ROUTR_DEFAULT_PEER_NAME,
		username: ROUTR_DEFAULT_PEER_USERNAME,
		password: ROUTR_DEFAULT_PEER_PASSWORD,
	};

	return credentials.createCredentials(request);
}

async function upsertDefaultPeer() {
	const peers = new SDK.Peers(routrConfig);

	logger.info("creating default peer");

	try {
		const request = {
			name: ROUTR_DEFAULT_PEER_NAME,
			username: ROUTR_DEFAULT_PEER_USERNAME,
			aor: ROUTR_DEFAULT_PEER_AOR,
			balancingAlgorithm: CT.LoadBalancingAlgorithm.ROUND_ROBIN,
			withSessionAffinity: false,
			maxContacts: -1,
			enabled: true,
		} as CreatePeerRequest;

		const peer = await peers.createPeer(request);

		logger.info("default Peer created", { peerRef: peer.ref });

		const creds = await createCredentialsForDefaultPeer();

		logger.info("credentials for default Peer created", {
			credentialsRef: creds.ref,
		});

		peer.credentialsRef = creds.ref;

		await peers.updatePeer(peer);

		logger.info("credentials associated with default Peer", {
			peerRef: peer.ref,
			credentialsRef: creds.ref,
		});
	} catch (err: unknown) {
		const error = err as { message: string; code: number };

		if (error.message.includes("already exist")) {
			logger.info("default peer already exist");
			return;
		}

		logger.error(`error creating default peer: ${error.message}`, {
			code: error.code,
		});
	}
}

export { upsertDefaultPeer };
