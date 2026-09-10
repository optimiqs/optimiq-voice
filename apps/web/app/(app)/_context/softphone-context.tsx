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
import { listCallLegs } from "~/lib/cdr/client";
import { listPbx, PBX_RESOURCES } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import {
	INITIAL_SOFTPHONE_STATE,
	softphoneReducer,
	type SoftphoneState,
} from "~/lib/softphone/call-state";
import { fetchMySoftphoneCredentials } from "~/lib/softphone/client";
import { shapeSoftphoneCredentials, softphoneUnavailability } from "~/lib/softphone/credentials";
import {
	NO_FEATURE_CODES,
	softphoneFeatureCodes,
	type SoftphoneFeatureCodes,
} from "~/lib/softphone/feature-codes";
import { recentCalls, type RecentCall } from "~/lib/softphone/recents";
import {
	canPauseRecording,
	canResumeRecording,
	IDLE_RECORDING,
	observedRecording,
	recordingEventForObservation,
	recordingReducer,
	type RecordingEvent,
	type RecordingState,
} from "~/lib/softphone/recording";
import { setCallRecordingPaused } from "~/lib/softphone/recording-client";
import { useLiveActiveCalls } from "../_hooks/use-live-queries";
import { useActiveOrganization, usePermission } from "./session-context";
import type { FeatureCodeRow } from "~/lib/pbx/contracts";
import type {
	ResolvedSoftphoneCredentials,
	SoftphoneConfiguredResponse,
	SoftphoneExtension,
	SoftphoneUnavailableReason,
} from "~/lib/softphone/contracts";
import type { SipUserAgent } from "~/lib/softphone/sip-adapter";

/**
 * The softphone's single source of truth, mounted once in the authenticated shell.
 *
 * ## What it does and does not do on load
 *
 * It FETCHES the caller's credentials as soon as an organization is active — cheap, cookie-authed,
 * and the answer is what the whole feature gates on (a user with no extension gets a 200 saying so,
 * and the widget shows nothing). It does NOT open a socket on load: registration is an explicit `connect()`
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
	/**
	 * The API's own name for that state, when it named one. The widget uses it to decide whether the
	 * gap is worth showing at all: `no-realm` reaches a user who DOES hold an extension and is fixable
	 * in Settings, while `no-extension` and `not-provisioned` are nothing this user can act on.
	 */
	readonly unavailableFor: SoftphoneUnavailableReason | null;
	/**
	 * Where an administrator fixes it, when the reason is fixable in this app. Today the one such
	 * reason is an organization with no SIP domain — the API refuses `/me/softphone` by name, and a
	 * link to the calling-domain form is more useful than a sentence describing it.
	 */
	readonly unavailableHref: string | null;
	readonly isLoading: boolean;
	readonly extension: SoftphoneExtension | null;
	readonly credentials: ResolvedSoftphoneCredentials | null;
	readonly state: SoftphoneState;
	/** Whether audio can traverse the platform media plane yet — `false` until mediad ships DTLS-SRTP. */
	readonly webrtcSupported: boolean;
	readonly mediaNote: string;
	/**
	 * The organization's own digits for the codes the phone offers a button for.
	 * `null` per action means "not configured here", and the control is not rendered — there is no
	 * platform default for a feature code, and a hardcoded `*76` would dial into the dial plan's
	 * no-match branch on every deployment that chose otherwise.
	 */
	readonly featureCodes: SoftphoneFeatureCodes;
	/** Recent calls on this extension, collapsed one-per-peer. Empty without `cdr.read.own`. */
	readonly recents: readonly RecentCall[];
	/** The last number this phone dialled, for Redial. Survives the call, not the tab. */
	readonly lastDialed: string | null;
	connect(): void;
	disconnect(): void;
	dial(target: string): void;
	answer(): void;
	hangup(): void;
	toggleHold(): void;
	toggleMute(): void;
	sendDtmf(tone: string): void;
	dismissEndedCall(): void;
	/** Blind transfer: REFER the call to `target` and let go of it. */
	transferBlind(target: string): void;
	/** Attended transfer, step one: hold this call and ring `target` to consult. */
	startConsult(target: string): void;
	/** Attended transfer, step two: REFER the held call to the consultation with `Replaces`. */
	completeTransfer(): void;
	/** Abandon the consultation and take the first call off hold. */
	cancelTransfer(): void;
	/**
	 * What the platform is recording on this call, and whether it is paused.
	 *
	 * Driven by the `active-calls` live topic, which carries the engine's own `recording` /
	 * `recording-paused` flags on every leg — see `lib/softphone/recording.ts`. `status: "off"`
	 * when nothing is recording OR when this session cannot read that topic (`cdr.read`), and the
	 * control is hidden in that state rather than disabled.
	 */
	readonly recording: RecordingState;
	/** Announces the platform's recording facts into the control's machine. */
	dispatchRecording(event: RecordingEvent): void;
	/** Pauses the recording — what an agent presses before asking for a card number. */
	pauseRecording(): void;
	resumeRecording(): void;
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
	const [lastDialed, setLastDialed] = useState<string | null>(null);
	const canReadFeatureCodes = usePermission("feature-codes.read");
	const canReadOwnCdr = usePermission("cdr.read.own");

	/**
	 * The credentials query.
	 *
	 * Every answer this app distinguishes is a 200 (`configured: true | false`), so there is no
	 * status to special-case here any more: a rejection is a real failure and retries on the default.
	 */
	const credentialsQuery = useQuery({
		queryKey: queryKeys.softphoneCredentials(organizationId),
		queryFn: fetchMySoftphoneCredentials,
		enabled: organizationId.length > 0,
	});

	/** The configured arm, or `null` — the one place the union is narrowed. */
	const configured = useMemo<SoftphoneConfiguredResponse | null>(() => {
		const data = credentialsQuery.data;
		return data?.configured === true ? data : null;
	}, [credentialsQuery.data]);

	const resolved = useMemo<ResolvedSoftphoneCredentials | null>(() => {
		if (!configured) {
			return null;
		}
		try {
			return shapeSoftphoneCredentials(configured, {
				pageOrigin: typeof window === "undefined" ? undefined : window.location.origin,
			});
		} catch {
			// No reachable WSS URL — a deployment gap, surfaced as unavailable rather than a broken UA.
			return null;
		}
	}, [configured]);

	const extensionNumber = configured?.extension.number ?? "";

	/**
	 * The organization's feature codes, for the DND and park controls.
	 *
	 * Behind `feature-codes.read`, which an ordinary extension holder does not hold — and that is
	 * the correct outcome rather than a gap: with no declaration to read, the buttons are not
	 * rendered, which is exactly what happens when the codes are not configured at all. A phone that
	 * showed a Park button dialling digits nobody defined would be worse.
	 */
	const featureCodesQuery = useQuery({
		queryKey: queryKeys.pbxList(organizationId, PBX_RESOURCES.featureCodes.key, {
			softphone: true,
		}),
		queryFn: async (): Promise<readonly FeatureCodeRow[]> =>
			(await listPbx(PBX_RESOURCES.featureCodes, { page: 1, limit: 100, enabled: true })).data,
		enabled: organizationId.length > 0 && canReadFeatureCodes,
		staleTime: 5 * 60 * 1000,
	});

	/**
	 * Recent calls on this extension, for Redial and the recents list.
	 *
	 * `?extension=` matches either side of a leg, so this is the caller's own history in both
	 * directions. `limit` is generous because the collapse in `recents.ts` throws most of it away:
	 * one two-party call writes up to four legs.
	 */
	const recentsQuery = useQuery({
		queryKey: queryKeys.cdrList(organizationId, { softphone: extensionNumber, limit: 40 }),
		queryFn: async () => (await listCallLegs({ extension: extensionNumber, limit: 40 })).data,
		enabled: organizationId.length > 0 && extensionNumber.length > 0 && canReadOwnCdr,
		staleTime: 30 * 1000,
	});

	const featureCodes = useMemo(
		() => (canReadFeatureCodes ? softphoneFeatureCodes(featureCodesQuery.data) : NO_FEATURE_CODES),
		[canReadFeatureCodes, featureCodesQuery.data],
	);

	const recents = useMemo<readonly RecentCall[]>(
		() =>
			recentsQuery.data && extensionNumber.length > 0
				? recentCalls(recentsQuery.data, extensionNumber)
				: [],
		[recentsQuery.data, extensionNumber],
	);

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
				refreshCredentials: async () => {
					// A refresh that comes back unconfigured means the extension was taken away mid-session.
					// Throwing is what the adapter turns into "calling could not start"; the alternative is
					// a UA that keeps the credentials it can no longer authenticate with.
					const fresh = await fetchMySoftphoneCredentials();
					if (!fresh.configured) {
						throw new Error(fresh.message);
					}
					return shapeSoftphoneCredentials(fresh, { pageOrigin: window.location.origin });
				},
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

	/**
	 * Un-REGISTER when the tab goes away.
	 *
	 * A WS binding is reachable only over the socket that made it, and sipd holds it until the
	 * registration lapses — so a closed tab leaves a contact every later call to this extension forks
	 * to, collects `connection refused` from, and files as a phantom CDR leg. Best-effort by nature:
	 * `pagehide` is the event that actually fires on a mobile/bfcache teardown where `beforeunload`
	 * does not, and neither is guaranteed on a crash. sipd dropping a WS binding with its transport
	 * is the real fix; this closes the ordinary case.
	 */
	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const unregister = () => {
			uaRef.current?.stop();
			uaRef.current = null;
		};
		window.addEventListener("pagehide", unregister);
		window.addEventListener("beforeunload", unregister);
		return () => {
			window.removeEventListener("pagehide", unregister);
			window.removeEventListener("beforeunload", unregister);
		};
	}, []);

	const connect = useCallback(() => {
		if (resolved) {
			setConnectRequested(true);
		}
	}, [resolved]);

	const dial = useCallback((target: string) => {
		const trimmed = target.trim();
		if (trimmed) {
			setLastDialed(trimmed);
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
	const transferBlind = useCallback((target: string) => {
		const trimmed = target.trim();
		if (trimmed) {
			uaRef.current?.transferBlind(trimmed);
		}
	}, []);
	const startConsult = useCallback((target: string) => {
		const trimmed = target.trim();
		if (trimmed) {
			uaRef.current?.startConsult(trimmed);
		}
	}, []);
	const completeTransfer = useCallback(() => uaRef.current?.completeTransfer(), []);
	const cancelTransfer = useCallback(() => uaRef.current?.cancelTransfer(), []);

	const [recording, dispatchRecording] = useReducer(recordingReducer, IDLE_RECORDING);

	/**
	 * One method for both directions, because the only difference is which path is posted.
	 *
	 * The guard is the machine's, not the button's: a disabled attribute is a rendering and this is
	 * the thing that must not send a second pause while the first is unanswered.
	 */
	const setRecordingPaused = useCallback(
		(paused: boolean) => {
			const callId = recording.callId;
			if (
				callId === null ||
				(paused ? !canPauseRecording(recording) : !canResumeRecording(recording))
			) {
				return;
			}
			dispatchRecording({ type: paused ? "PAUSE_REQUESTED" : "RESUME_REQUESTED" });
			void setCallRecordingPaused(callId, paused).then(
				() => dispatchRecording({ type: paused ? "PAUSE_CONFIRMED" : "RESUME_CONFIRMED" }),
				(error: unknown) =>
					dispatchRecording({
						type: "RECORDING_CONTROL_FAILED",
						reason:
							error instanceof ApiError
								? error.message
								: "The recording could not be changed. It is unchanged.",
					}),
			);
		},
		[recording],
	);
	const pauseRecording = useCallback(() => setRecordingPaused(true), [setRecordingPaused]);
	const resumeRecording = useCallback(() => setRecordingPaused(false), [setRecordingPaused]);

	/**
	 * The producer: what the PLATFORM says the recorder is doing on this agent's call.
	 *
	 * The `active-calls` topic carries every live leg in the organization with the engine's own
	 * `recording` / `recording-paused` flags on it, and `observedRecording` picks this agent's out by
	 * extension. Nothing in the browser could derive this — jssip knows about a SIP dialog and
	 * nothing about what the platform is writing to disk.
	 *
	 * **Behind `cdr.read`, which is the topic's own permission.** An agent without it gets an empty
	 * feed and therefore no control, which is the honest failure: the pause is hidden rather than
	 * offered over a recorder nothing can see the state of. Widening that gate is a change to
	 * `LIVE_TOPIC_PERMISSIONS`, not to this file.
	 */
	const liveCalls = useLiveActiveCalls();
	const observation = useMemo(
		// Only while a call is actually up on this phone. The feed lags a hangup by a beat, and
		// without this gate the control would light back up on a call that has just ended — undoing
		// the `RECORDING_STOPPED` the effect below dispatches for exactly that transition.
		() =>
			state.call.status === "active" || state.call.status === "ringing"
				? observedRecording(liveCalls.legs, extensionNumber)
				: undefined,
		[liveCalls.legs, extensionNumber, state.call.status],
	);
	useEffect(() => {
		// Only when the feed DISAGREES with what the control shows — see
		// `recordingEventForObservation`, which is also what keeps a request in flight from being
		// cleared by a snapshot that raced its reply.
		const event = recordingEventForObservation(recording, observation);
		if (event !== undefined) {
			dispatchRecording(event);
		}
	}, [observation, recording]);

	// The recording belongs to the CALL: a new one must not inherit the last one's control state.
	const callStatus = state.call.status;
	useEffect(() => {
		if (callStatus === "idle" || callStatus === "ended") {
			dispatchRecording({ type: "RECORDING_STOPPED" });
		}
	}, [callStatus]);

	const unavailableFor =
		credentialsQuery.data?.configured === false ? credentialsQuery.data.reason : null;
	const { reason: unavailableReason, href: unavailableHref } = softphoneUnavailability({
		...(unavailableFor === null ? {} : { reason: unavailableFor }),
		hasCredentials: configured !== null,
		resolved: resolved !== null,
	});

	// Memoised for the reason `live-context` is: every `useSoftphone()` consumer re-renders when this
	// object's identity changes, and the provider re-renders on every SIP event dispatched into the
	// reducer. The callbacks below are already stable, so only the reducer state, the resolved
	// credentials and the query flags actually move.
	const value = useMemo<SoftphoneContextValue>(
		() => ({
			available: resolved !== null,
			unavailableReason,
			unavailableHref,
			unavailableFor,
			isLoading: credentialsQuery.isPending && organizationId.length > 0,
			extension: configured?.extension ?? null,
			credentials: resolved,
			state,
			featureCodes,
			recents,
			lastDialed,
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
			transferBlind,
			startConsult,
			completeTransfer,
			cancelTransfer,
			recording,
			dispatchRecording,
			pauseRecording,
			resumeRecording,
		}),
		[
			resolved,
			unavailableReason,
			unavailableHref,
			unavailableFor,
			credentialsQuery.isPending,
			configured,
			organizationId,
			state,
			connect,
			teardown,
			dial,
			answer,
			hangup,
			toggleHold,
			toggleMute,
			sendDtmf,
			dismissEndedCall,
			featureCodes,
			recents,
			lastDialed,
			transferBlind,
			startConsult,
			completeTransfer,
			cancelTransfer,
			recording,
			pauseRecording,
			resumeRecording,
		],
	);

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
