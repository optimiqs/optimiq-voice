import { createJsSipUserAgent } from "../../apps/web/lib/softphone/jssip-adapter";
import { shapeSoftphoneCredentials } from "../../apps/web/lib/softphone/credentials";

// Isolated test page: synthetic microphone, real browser PeerConnections and product SIP adapter.
const scope = window as unknown as Record<string, any>;
scope.events = [];
scope.connections = [];
scope.refreshes = 0;
scope.rtcErrors = [];
const NativePeerConnection = window.RTCPeerConnection;
window.RTCPeerConnection = class extends NativePeerConnection {
	async setRemoteDescription(description: RTCSessionDescriptionInit) {
		try { return await super.setRemoteDescription(description); }
		catch (error) { scope.rtcErrors.push({ error: String(error), sdp: description.sdp }); throw error; }
	}
	constructor(configuration?: RTCConfiguration) {
		super({ ...configuration, ...(new URLSearchParams(location.search).has("relay") ? { iceTransportPolicy: "relay" } : {}) });
		scope.connections.push(this);
	}
};
const audioContext = new AudioContext();
navigator.mediaDevices.getUserMedia = async () => {
	await audioContext.resume();
	const oscillator = audioContext.createOscillator();
	oscillator.frequency.value = 660;
	const destination = audioContext.createMediaStreamDestination();
	oscillator.connect(destination);
	oscillator.start();
	destination.stream.getAudioTracks()[0]!.addEventListener("ended", () => oscillator.stop());
	return destination.stream;
};
const credentials = async () => {
	scope.refreshes++;
	return shapeSoftphoneCredentials(await (await fetch(`/credentials${location.search}`)).json());
};
void credentials().then((initial) => {
	const client = createJsSipUserAgent({
		credentials: initial,
		refreshCredentials: credentials,
		media: { remoteAudio: document.querySelector("audio") },
		onEvent: event => {
			scope.events.push(event);
			if (event.type === "INCOMING_CALL") client.answer();
		},
	});
	scope.client = client;
	scope.audioEvidence = async () => {
		const pc = scope.connections.at(-1) as RTCPeerConnection | undefined;
		if (!pc || pc.connectionState === "closed") return undefined;
		return [...(await pc.getStats()).values()].find(report => report.type === "inbound-rtp" && report.kind === "audio");
	};
	client.start();
});
