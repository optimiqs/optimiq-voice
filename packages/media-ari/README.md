# `@optimiq-voice/media-ari`

A typed Asterisk 22 ARI adapter: REST resources, a discriminated event union, and a reconnecting
event socket.

It is a **protocol adapter and nothing else**. There is no domain logic here, and there are no
imports of `@optimiq-voice/telephony`, `@optimiq-voice/events` or `nats`. That constraint is the
point: the plan (§3.4 option E, §8 risk 1) says the engine does not change when `apps/mediad`
replaces Asterisk, and that is only true if every ARI quirk lives behind this boundary.

## Usage

```ts
import { AriClient } from "@optimiq-voice/media-ari";

const client = new AriClient({
	baseUrl: "http://asterisk:8088", // with or without /ari; both normalise the same way
	username: "ari",
	password: process.env.ARI_PASSWORD!,
	app: "optimiq-engine",
});

// Prove the credentials before opening a socket, so a bad password fails at boot.
const { version } = await client.ping();

const stream = client.createEventStream({
	onEvent: (event) => {
		if (event.type === "StasisStart") {
			void client.channels.answer(event.channel.id);
		}
	},
	onGap: (gap) => log.warn(gap, "events were lost while the socket was down"),
});

await stream.start(); // resolves on the FIRST successful connection
// …
stream.close();
```

## What it covers

| Area           | Methods                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`     | get, list, answer, ring/ringStop, hangup, continueInDialplan, play, record, get/setVariable, originate, dial, redirect, sendDtmf, mute/unmute, hold/unhold, startMoh/stopMoh, snoop |
| `bridges`      | get, list, create, addChannels, removeChannels, destroy, startMoh/stopMoh                                                                                                           |
| `playbacks`    | get, stop, control                                                                                                                                                                  |
| `recordings`   | getLive, stop, cancel, pause/unpause, getStored, deleteStored                                                                                                                       |
| `endpoints`    | list, listByTechnology, get                                                                                                                                                         |
| `deviceStates` | list, get (READ ONLY — presence is derived by the engine, never written into Asterisk)                                                                                              |
| `applications` | get, list, subscribe, unsubscribe                                                                                                                                                   |
| `asterisk`     | info                                                                                                                                                                                |

Events are typed for `StasisStart`/`StasisEnd`, the channel lifecycle (`ChannelCreated`,
`ChannelStateChange`, `ChannelDtmfReceived`, `ChannelDestroyed`, `ChannelHangupRequest`,
`ChannelVarset`, `ChannelHold`/`Unhold`, `ChannelDialplan`), playback, recording, bridge membership
and `Dial`. Everything else arrives as `AriUnknownEvent` with its raw payload intact.

## Decisions worth knowing

- **No `ws` dependency.** Node ≥22 ships a global `WebSocket`. The one thing it cannot do is set
  request headers, so authentication uses ARI's documented `api_key=user:pass` query parameter.
  That credential is produced in exactly one function (`buildEventsUrl`) and `redactAriUrl` exists
  so nothing else has an excuse to log the raw string.
- **ARI has no sequence numbers and no replay.** Events that happen while the socket is down are
  gone. The stream therefore reports an `AriEventGap` on every reconnect — downtime, attempts, and
  how many events the previous session saw — so the loss is visible rather than silent.
- **404 is a status, not a failure**, on the operations that race a hangup: `channels.hangup`,
  `bridges.destroy`, `playbacks.stop` and the variable reads resolve to `undefined`.
- **Validation where it matters.** Resource objects are Zod-validated (a `Channel` without an `id`
  is rejected at the edge, where the raw JSON is still available to log), but every schema is a
  `z.object`, so unknown keys from a newer Asterisk pass through rather than breaking a patch
  upgrade.

## Tests

```sh
pnpm --filter @optimiq-voice/media-ari test              # 81 pure specs
pnpm --filter @optimiq-voice/media-ari test:integration  # + 7 against a real Asterisk 22
```

The integration suite builds and runs `apps/asterisk` as a throwaway container, originates a Local
channel into a Stasis app, answers it and hangs it up with an explicit Q.850 cause. Point
`ARI_INTEGRATION_URL` (plus `ARI_INTEGRATION_USERNAME` / `ARI_INTEGRATION_PASSWORD`) at an Asterisk
you already run to skip Docker; only containers the suite started are removed.
