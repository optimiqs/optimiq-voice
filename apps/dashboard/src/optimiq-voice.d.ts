/**
 * Optimiq Voice Client (Browser)
 *
 * @description This file exports the Optimiq Voice Client for the browser. It is used to
 * create a new instance of the Optimiq Voice Client for the browser.
 *
 * @TODO: Remove this file when the Optimiq Voice Client is available in the browser.
 */
declare module "@optimiq-voice/sdk/dist/web/index.esm.js" {
	import * as SDK from "@optimiq-voice/sdk";

	export class WebClient extends SDK.Client {}
	export * from "@optimiq-voice/sdk";
}

/**
 * Optimiq Voice Client (Node)
 *
 * @description This file exports the Optimiq Voice Client for Node. It is used to
 * create a new instance of the Optimiq Voice Client for Node.
 */
declare module "@optimiq-voice/sdk/dist/node/node.js" {
	import * as SDK from "@optimiq-voice/sdk";

	export class Client extends SDK.Client {}
	export * from "@optimiq-voice/sdk";
}
