"use client";

import {
	createContext,
	use,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { resolveApiOrigin } from "~/lib/api-client";
import { LiveClient, type LiveStatus, type LiveTopicHandlers } from "~/lib/live/client";
import { topicKind, type LiveTopic } from "~/lib/live/protocol";

/**
 * The live channel, as one socket per tab.
 *
 * ## Where it lives, and why not at the root
 *
 * Next to `QueryClientProvider` inside the authenticated shell, and for the same reason: the socket
 * is scoped to a SESSION. Signing out unmounts the shell, which destroys the client, which closes
 * the socket — so the next user cannot inherit a stream of the previous one's organization. A
 * provider at the root layout would outlive both.
 *
 * ## Nothing connects until something subscribes
 *
 * `LiveClient` opens the socket on the first lease. Most pages in this app are ordinary CRUD and
 * never take one, and a socket per tab costs the server a session resolution and a heartbeat — so
 * paying that only on the screens that use it is the difference between a live feature and a live
 * connection for everyone.
 */

interface LiveContextValue {
	readonly client: LiveClient | null;
	readonly status: LiveStatus;
	readonly allowedTopicKinds: readonly string[];
	/** Whether the server has said what this session may watch yet. */
	readonly welcomed: boolean;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
	/**
	 * The client is created BY the effect that destroys it, not held in a `useState` initialiser.
	 *
	 * `destroy()` is permanent by contract — it stops reconnecting, which is what an unmounting shell
	 * wants. A client created outside the effect therefore survives its own destruction: React's
	 * StrictMode mounts, unmounts and remounts every effect in development, so the second mount
	 * inherited a client that had already been stopped and would never open a socket again. That is
	 * the "Reconnecting" every live page sat on locally, and it is exactly the bug StrictMode's
	 * double-invoke exists to surface. Owning the client here makes the remount build a live one.
	 */
	const [client, setClient] = useState<LiveClient | null>(null);
	const [status, setStatus] = useState<LiveStatus>("closed");
	const [allowedTopicKinds, setAllowedTopicKinds] = useState<readonly string[]>([]);
	const [welcomed, setWelcomed] = useState(false);

	useEffect(() => {
		// The socket goes to the API's origin, not necessarily this page's: Next's `rewrites` proxy
		// HTTP and cannot carry a WebSocket upgrade, so a deployment where Next is the proxy has to
		// name the API. `resolveApiOrigin` falls back to the page origin, which is right behind a
		// reverse proxy that forwards the upgrade. See `docs/native-calling-deployment.md`.
		const created = new LiveClient({ origin: resolveApiOrigin(window.location.origin) });
		setClient(created);
		const detachStatus = created.onStatusChange(setStatus);
		// `welcome` arrives a round trip AFTER the socket opens, so it needs its own notification:
		// reading the allowed kinds on the status change would read them before the server had said
		// anything, and there is no second status change to prompt a re-read.
		const detachWelcome = created.onWelcome((kinds) => {
			setAllowedTopicKinds(kinds);
			setWelcomed(true);
		});
		return () => {
			detachStatus();
			detachWelcome();
			setWelcomed(false);
			setAllowedTopicKinds([]);
			created.destroy();
		};
	}, []);

	const value = useMemo(
		() => ({ client, status, allowedTopicKinds, welcomed }),
		[client, status, allowedTopicKinds, welcomed],
	);

	return <LiveContext value={value}>{children}</LiveContext>;
}

function useLiveContext(): LiveContextValue {
	const value = use(LiveContext);
	if (value === null) {
		throw new Error("useLive must be used inside the authenticated layout's LiveProvider.");
	}
	return value;
}

/** Whether the socket is up, for a "Live" / "Reconnecting" indicator. */
export function useLiveStatus(): LiveStatus {
	return useLiveContext().status;
}

/**
 * Takes a lease on one topic for the lifetime of the component.
 *
 * `handlers` is deliberately read through a ref rather than being a dependency: a caller that
 * built its handlers inline — which every caller does — would otherwise resubscribe on every
 * render, and each resubscribe costs a server round trip and a fresh snapshot.
 *
 * `enabled: false` takes no lease at all. Used to gate a topic on a permission the session does not
 * hold, so the socket is never asked for something it would be refused.
 */
export function useLiveTopic(
	topic: LiveTopic | null,
	handlers: LiveTopicHandlers,
	options: { readonly enabled?: boolean } = {},
): void {
	const { client, allowedTopicKinds, welcomed } = useLiveContext();
	// The latest-ref pattern, written as a layout effect rather than an assignment in the render
	// body: a render that is discarded would otherwise have already overwritten the box, and a tree
	// resumed afterwards would dispatch into an abandoned render's handlers.
	const handlerBox = useRef(handlers);
	useLayoutEffect(() => {
		handlerBox.current = handlers;
	});

	const enabled = options.enabled !== false && topic !== null;
	// The welcome frame lists what this session may watch, so nothing subscribes until it lands:
	// a component that renders before permissions are known does not send a subscribe that will be
	// denied, and once the frame arrives the effect re-runs and the lease is taken. Gating on the
	// FLAG rather than on an empty list matters — a session legitimately allowed nothing would
	// otherwise be treated as allowed everything.
	const permitted = topic === null || (welcomed && allowedTopicKinds.includes(topicKind(topic)));

	// Opening the socket is what MAKES the welcome frame arrive, and the client opens it lazily —
	// on the first `subscribe`. Gating that subscribe on the welcome therefore closed a loop with
	// nothing in it: no screen ever subscribed, so no socket was ever opened, so no welcome ever
	// landed, and every live surface in the app sat on "Reconnecting" forever. Asking for the
	// connection here keeps the laziness that matters — a page with no live topic still opens
	// nothing — while letting the handshake that decides `permitted` actually happen.
	useEffect(() => {
		if (client === null || !enabled || permitted) {
			return;
		}
		client.connect();
	}, [client, enabled, permitted]);

	useEffect(() => {
		if (client === null || topic === null || !enabled || !permitted) {
			return;
		}
		return client.subscribe(topic, {
			onSnapshot: (event) => handlerBox.current.onSnapshot?.(event),
			onUpdate: (event) => handlerBox.current.onUpdate?.(event),
			onDenied: (denied) => handlerBox.current.onDenied?.(denied),
		});
	}, [client, topic, enabled, permitted, handlerBox]);
}
