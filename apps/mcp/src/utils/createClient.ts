import * as SDK from "@optimiq-voice/sdk";
import {
	ACCESS_KEY_ID,
	ACCESS_KEY_SECRET,
	ALLOW_INSECURE,
	ENDPOINT,
	WORKSPACE_ACCESS_KEY_ID,
} from "../env";

export async function createClient() {
	const client = new SDK.Client({
		accessKeyId: WORKSPACE_ACCESS_KEY_ID,
		endpoint: ENDPOINT,
		allowInsecure: ALLOW_INSECURE,
	});
	await client.loginWithApiKey(ACCESS_KEY_ID, ACCESS_KEY_SECRET);
	return client;
}
