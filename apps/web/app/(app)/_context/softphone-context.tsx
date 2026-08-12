"use client";

import { useQuery } from "@tanstack/react-query";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { ApiError } from "~/lib/api-client";
import { queryKeys } from "~/lib/query-keys";
import {
	INITIAL_SOFTPHONE_STATE,
	softphoneReducer,
	type SoftphoneState,
} from "~/lib/softphone/call-state";
import { fetchMySoftphoneCredentials } from "~/lib/softphone/client";
import { shapeSoftphoneCredentials } from "~/lib/softphone/credentials";
import { useActiveOrganization } from "./session-context";
import type { ResolvedSoftphoneCredentials, SoftphoneExtension } from "~/lib/softphone/contracts";
import type { SipUserAgent } from "~/lib/softphone/sip-adapter";

/**
 * The softphone's single source of truth, mounted once in the authenticated shell.
 *
 * ## What it does and does not do on load
 *
 * It FETCHES the caller's credentials as soon as an organization is active — cheap, cookie-authed,
 * and the answer is what the whole feature gates on (a user with no extension gets a 404 and the
 * widget shows nothing). It does NOT open a socket on load: registration is an explicit `connect()`
 * so a browser tab does not hold a WSS registration the user never asked for, and so a deployment
 * without sipd's WSS listener does not spray connection errors into every page.
 *
 * ## jssip is loaded lazily, on the client, on connect
 *
 * The jssip adapter touches `navigator`/`window` at construction, so it is imported with a dynamic
 * `import()` inside `connect()` — never at module scope. That keeps it out of the server render and
 * out of the initial bundle until a user actually places the phone online.
 */

export interface SoftphoneContextValue {
	/** True when the caller holds an extension AND the deployment exposes a browser SIP transport. */
	readonly available: boolean;
	/** Why the softphone is not available, for the widget to explain rather than hide silently. */
	readonly unavailableReason: string | null;
	readonly isLoading: boolean;
	readonly extension: SoftphoneExtension | null;
	readonly credentials: ResolvedSoftphoneCredentials | null;
	readonly state: SoftphoneState;
	/** Whether audio can traverse the platform media plane yet — `false` until mediad ships DTLS-SRTP. */
	readonly webrtcSupported: boolean;
	readonly mediaNote: string;
	connect(): void;
	disconnect(): void;
	dial(target: string): void;
	answer(): void;
	hangup(): void;
	toggleHold(): void;
	toggleMute(): void;
	sendDtmf(tone: string): void;
	dismissEndedCall(): void;
}

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

export function useSoftphone(): SoftphoneContextValue {
	const value = useContext(SoftphoneContext);
	if (!value) {
		throw new Error(
			"useSoftphone must be used inside the authenticated layout's SoftphoneProvider.",
		);
	}
	return value;
}

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

export function SoftphoneProvider({ children }: { children: ReactNode }) {
	const organizationId = useOrganizationId();
	const [state, dispatch] = useReducer(softphoneReducer, INITIAL_SOFTPHONE_STATE);
	const uaRef = useRef<SipUserAgent | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const [connectRequested, setConnectRequested] = useState(false);

	/**
	 * The credentials query.
	 *
	 * A 404 is the "you have no extension" answer and must NOT retry — it is a stable fact about the
	 * caller, not a transient failure. Every other error retries on React Query's defaults.
	 */
	const credentialsQuery = useQuery({
		queryKey: queryKeys.softphoneCredentials(organizationId),
		queryFn: fetchMySoftphoneCredentials,
		enabled: organizationId.length > 0,
		retry: (failureCount, error) =>
			error instanceof ApiError && error.status === 404 ? false : failureCount < 2,
	});

	const resolved = useMemo<ResolvedSoftphoneCredentials | null>(() => {
		if (!credentialsQuery.data) {
			return null;
		}
		try {
			return shapeSoftphoneCredentials(credentialsQuery.data, {
				pageOrigin: typeof window === "undefined" ? undefined : window.location.origin,
			});
		} catch {
			// No reachable WSS URL — a deployment gap, surfaced as unavailable rather than a broken UA.
			return null;
		}
	}, [credentialsQuery.data]);

	const teardown = useCallback(() => {
		uaRef.current?.stop();
		uaRef.current = null;
		setConnectRequested(false);
		dispatch({ type: "REGISTRATION_CHANGED", state: "unregistered" });
	}, []);

	// Bring the UA online once a connect has been requested and credentials are resolved.
	useEffect(() => {
		if (!connectRequested || !resolved || uaRef.current) {
			return;
		}
		let cancelled = false;
		void (async () => {
			const { createJsSipUserAgent } = await import("~/lib/softphone/jssip-adapter");
			if (cancelled) {
				return;
			}
			const ua = createJsSipUserAgent({
				credentials: resolved,
				media: { remoteAudio: audioRef.current },
				onEvent: dispatch,
			});
			uaRef.current = ua;
			ua.start();
		})();
		return () => {
			cancelled = true;
		};
	}, [connectRequested, resolved]);

	// Tear the registration down when the org changes or the shell unmounts (sign-out).
	useEffect(() => teardown, [organizationId, teardown]);

	const connect = useCallback(() => {
		if (resolved) {
			setConnectRequested(true);
		}
	}, [resolved]);

	const dial = useCallback((target: string) => {
		const trimmed = target.trim();
		if (trimmed) {
			uaRef.current?.call(trimmed);
		}
	}, []);

	const answer = useCallback(() => uaRef.current?.answer(), []);
	const hangup = useCallback(() => uaRef.current?.hangup(), []);
	const toggleHold = useCallback(
		() => uaRef.current?.setHold(!state.call.onHold),
		[state.call.onHold],
	);
	const toggleMute = useCallback(
		() => uaRef.current?.setMuted(!state.call.muted),
		[state.call.muted],
	);
	const sendDtmf = useCallback((tone: string) => {
		uaRef.current?.sendDtmf(tone);
		dispatch({ type: "DTMF_SENT", tone });
	}, []);
	const dismissEndedCall = useCallback(() => dispatch({ type: "RESET_CALL" }), []);

	const noExtension =
		credentialsQuery.error instanceof ApiError && credentialsQuery.error.status === 404;
	const unavailableReason = noExtension
		? "You do not hold an extension on this organization."
		: credentialsQuery.data && !resolved
			? "This deployment has no browser SIP transport (sipd WSS) configured yet."
			: null;

	const value: SoftphoneContextValue = {
		available: resolved !== null,
		unavailableReason,
		isLoading: credentialsQuery.isPending && organizationId.length > 0,
		extension: credentialsQuery.data?.extension ?? null,
		credentials: resolved,
		state,
		webrtcSupported: resolved?.webrtcSupported ?? false,
		mediaNote:
			resolved?.mediaNote ??
			"The media plane's WebRTC leg (DTLS-SRTP in mediad) is the remaining piece; calls signal but carry no audio yet.",
		connect,
		disconnect: teardown,
		dial,
		answer,
		hangup,
		toggleHold,
		toggleMute,
		sendDtmf,
		dismissEndedCall,
	};

	return (
		<SoftphoneContext.Provider value={value}>
			{children}
			{/*
			 * The remote-audio sink. Wired for the day mediad ships DTLS-SRTP; on today's platform no
			 * track ever attaches, which the widget states in words rather than leaving this element
			 * to imply sound will play. The empty caption track is there only to satisfy a11y lint — a
			 * live SIP call has no captions to carry.
			 */}
			{/* eslint-disable-next-line jsx-a11y/media-has-caption */}
			<audio ref={audioRef} autoPlay hidden>
				<track kind="captions" />
			</audio>
		</SoftphoneContext.Provider>
	);
}
