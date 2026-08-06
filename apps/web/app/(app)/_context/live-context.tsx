"use client";

import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
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
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
	// `useState` with an initialiser, not `useMemo`: a memo may be discarded and recomputed, and a
	// second client would be a second socket whose first one nobody closed.
	const [client] = useState(() =>
		typeof window === "undefined" ? null : new LiveClient({ origin: window.location.origin }),
	);
	const [status, setStatus] = useState<LiveStatus>("closed");
	const [allowedTopicKinds, setAllowedTopicKinds] = useState<readonly string[]>([]);

	useEffect(() => {
		if (client === null) {
			return;
		}
		const detachStatus = client.onStatusChange(setStatus);
		// `welcome` arrives a round trip AFTER the socket opens, so it needs its own notification:
		// reading the allowed kinds on the status change would read them before the server had said
		// anything, and there is no second status change to prompt a re-read.
		const detachWelcome = client.onWelcome(setAllowedTopicKinds);
		return () => {
			detachStatus();
			detachWelcome();
			client.destroy();
		};
	}, [client]);

	const value = useMemo(
		() => ({ client, status, allowedTopicKinds }),
		[client, status, allowedTopicKinds],
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
	const { client, allowedTopicKinds } = useLiveContext();
	const [handlerBox] = useState(() => ({ current: handlers }));
	handlerBox.current = handlers;

	const enabled = options.enabled !== false && topic !== null;
	// The welcome frame lists what this session may watch. Checking it here means a component
	// that renders before permissions are known does not send a subscribe that will be denied —
	// and once the frame arrives, the effect re-runs and the lease is taken.
	const permitted =
		topic === null || allowedTopicKinds.length === 0 || allowedTopicKinds.includes(topicKind(topic));

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
