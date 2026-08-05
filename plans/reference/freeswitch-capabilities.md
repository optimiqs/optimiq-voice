# FreeSWITCH Capability & Domain-Model Reference (frozen 2026-08-05)

Extracted from the vendored FreeSWITCH source before deletion. This is the capability spec the TypeScript engine must satisfy. FreeSWITCH code/naming must NOT be copied — only these behaviors.

## 1. Channel/session model

- **Session**: runtime container, UUID-identified (the universal handle for every command). Owns channel, codecs, media, event queue.
- **Channel**: signaling/state view of one call leg. Holds state, flags, variables, caller profiles, DTMF queue.
- **Caller profile** (per routing hop): caller_id_name/number, ani, rdnis, destination_number, context, network_addr, source, chan_name.
- **Channel state machine**: `NEW → INIT → ROUTING → EXECUTE → EXCHANGE_MEDIA` with side states `PARK / CONSUME_MEDIA / SOFT_EXECUTE / HIBERNATE / RESET`, then `HANGUP → REPORTING → DESTROY`.
- **User-visible call states** (drive BLF, emitted as callstate events): `DOWN, DIALING, RINGING, EARLY, ACTIVE, HELD, RING_WAIT, HANGUP, UNHELD`.
- **Device states** (aggregate a user's channels for BLF): `DOWN, RINGING, ACTIVE, ACTIVE_MULTI, HELD, UNHELD, HANGUP`.
- Key flags: ANSWERED, OUTBOUND, EARLY_MEDIA, BRIDGED, HOLD, TRANSFER, ATTENDED_TRANSFER, REDIRECT, PARK, PROXY_MODE (bypass media), PROXY_MEDIA, VIDEO.
- **Bridge modes**: full media (relay+transcode), signal-only (media p2p), bypass-media (SDP passthrough), proxy-media (relay w/o decode). Media can be toggled mid-call (re-INVITE).
- **Answer semantics**: ring_ready→SIP 180 (no media); pre_answer→183+SDP (early media; audio before answer/billing); answer→200 OK.

## 2. Originate/dial semantics

- Multi-target: `a|b` ring-all simultaneous; `a,b` sequential failover; enterprise-parallel (`:_:`) independent originations.
- `{vars}` all legs, `[vars]` per leg. Control vars: call_timeout, progress_timeout, ignore_early_media, continue_on_fail (bool or CSV of hangup causes), hangup_after_bridge, bridge_early_media, origination_caller_id_*, group_confirm_key/file (answer confirmation), failure_causes.
- Canonical local-extension pattern: timeout 30 → continue_on_fail → answer + voicemail fallback.
- Ring-all cleanup: losing legs hang up with cause `LOSE_RACE`.

## 3. Transfers / hold / park / pickup

- Blind transfer: reset leg to ROUTING in target context; SIP REFER inbound; cause BLIND_TRANSFER(800). Options: transfer -bleg / -both.
- Attended transfer: hold B, originate C, consult, complete on transferor hangup or cancel-key abort; cause ATTENDED_TRANSFER(801); transfer_fallback_extension for failures.
- Deflect = SIP 302; redirect = 3xx; respond = arbitrary SIP code. uuid_bridge joins two live calls.
- Hold/unhold with MOH (shared streaming source `local_stream://moh`, NOT per-call file reads); soft_hold; events CHANNEL_HOLD/UNHOLD; rtp-hold-timeout.
- Park: simple park/retrieve + valet lots with auto-assigned or explicit orbit slots, park timeout returns to parker.
- Pickup/intercept: directed (**ext), group (*8), global (886); needs "who last rang whom" state.

## 4. DTMF

- Sources: RFC 2833 telephone-event (PT 101), SIP INFO, inband detect, app-generated. Per-channel queue.
- Collection: play_and_get_digits w/ regex validation + retries; inter-digit timeouts.
- Bindings: meta-app feature keys (*1 transfer, *2 record, *3 conference, *4 att_xfer after `*` prefix, per-leg a/b) and a full digit-machine (realms, regex patterns, timeouts, match/no-match callbacks).

## 5. Media bugs (tap primitive — powers everything below)

- Read/write stream taps, stereo (per-leg channels), replace variants.
- Call recording (on-demand + always-on, pause/resume/mask for PCI), eavesdrop (listen/whisper-A/whisper-B/barge via DTMF 1/2/3), displace (inject audio into live call), intercept, three-way, speech/tone/VAD detection.
- Events: RECORD_START/STOP, MEDIA_BUG_START/STOP, PLAYBACK_START/STOP.

## 6. Hangup-cause taxonomy (adopt verbatim — routing keys off it)

Full Q.850 (1–127) plus extensions: ORIGINATOR_CANCEL(487), LOSE_RACE(702), BLIND_TRANSFER(800), ATTENDED_TRANSFER(801), ALLOTTED_TIMEOUT(802), USER_CHALLENGE(803), MEDIA_TIMEOUT(804), PICKED_OFF(805), USER_NOT_REGISTERED(806), PROGRESS_TIMEOUT(807), INVALID_GATEWAY(808), GATEWAY_DOWN(809), INVALID_URL(810), INVALID_PROFILE(811), NO_PICKUP(812), SRTP_READ_ERROR(813).

## 7. Routing/dialplan model

- Contexts = named routing namespaces + security boundary: authenticated users → `default`-like context; unauthenticated external traffic → `public`-like context; NEVER let unauthenticated traffic reach trunk-capable routes (toll fraud rule #1).
- Extensions evaluated top-to-bottom; all conditions must match; `continue` lets later extensions also run (global-settings pattern); `break` on-false/on-true/always/never; anti-actions on no-match.
- Condition fields: destination_number, caller_id_number/name, ani, rdnis, network_addr + arbitrary variable/inline-API expansion. PCRE regex, capture groups $1..$n usable in action data.
- **Time-of-day predicates as first-class condition fields**: year, yday, mon, mday, week, mweek, wday, hour, minute, minute-of-day, time-of-day, date-time, timezone; ranges and lists. This is business-hours/holiday routing.
- Variable scopes: channel (`set`), exported-to-B-leg (`export`, `nolocal:` prefix), global. Inline API expansion in action data.
- Context moves: transfer (re-route), execute_extension (inline call + return).
- Dynamic config: entire dialplan/directory/config servable per-request from an HTTP backend (mod_xml_curl model) with caching — the blueprint for our Routing Compiler + cache invalidation.

## 8. Eventing model

- Event = name + header map + body; serialize plain/XML/JSON. Channel events carry full caller + other-leg profiles + every channel variable.
- Core types to reproduce: CHANNEL_CREATE/ORIGINATE/PROGRESS/PROGRESS_MEDIA/ANSWER/BRIDGE/UNBRIDGE/HOLD/UNHOLD/PARK/UNPARK/EXECUTE/EXECUTE_COMPLETE/HANGUP/HANGUP_COMPLETE/DESTROY, CHANNEL_STATE, CHANNEL_CALLSTATE, DEVICE_STATE, DTMF, RECORD_START/STOP, PLAYBACK_START/STOP, DETECTED_TONE/SPEECH, TALK/NOTALK, PRESENCE_IN/OUT, MESSAGE_WAITING (MWI), BACKGROUND_JOB (async result w/ Job-UUID correlation), HEARTBEAT, STARTUP/SHUTDOWN, MODULE load/unload, custom subclassed events (register/unregister/expire, gateway_state, conference::maintenance, callcenter::info, vm::maintenance).
- **ESL model → our session protocol**: inbound mode (client connects: subscribe to events w/ filters, run api (sync) / bgapi (async+Job-UUID), per-channel `myevents`) and outbound mode (engine connects to app per call: full channel dump, then execute/hangup/transfer commands, async vs sync execution, `linger` to receive post-hangup events, `full` vs single-channel scope). Our equivalent: typed gRPC/WS bidi stream (exists as Voice CreateSession — extend, don't reinvent).

## 9. Module capability map (what a complete PBX offers)

- dptools verb set (~150): bridge, answer, playback, record, transfer, att_xfer, hold, park, set/export, eavesdrop, intercept, pickup, three_way, limit, sched_hangup, play_and_get_digits, sleep, say, phrase, privacy…
- commands API (~190): originate, uuid_* (bridge/transfer/hold/kill/park/record/getvar/setvar/dump/send_dtmf/broadcast/media/deflect), show channels/calls/registrations, hupall, sched_api, reloadxml, group_call, limit_usage…
- Conference: rooms, profiles, member flags (mute/deaf/moderator), floor/active-speaker, PINs, recording, per-conf MOH, kick/volume/energy, events + CDRs.
- Voicemail: boxes, PIN login, greetings (personal/name), folders, forward, email delivery, MWI NOTIFY, callback, navigation keys.
- Queues: FIFO (simple: simo parallel dials, lag, priority) and full ACD (agents w/ states, tiers level+position, strategies: longest-idle/ring-all/round-robin/top-down/sequential/random, wrap-up, max-no-answer, abandoned tracking, queue recording, DB-backed state).
- Fax: T.30 over G.711 + T.38, fax detect (CNG/CED), send/receive, result events.
- Say/phrase: 18 languages, number/date/money rendering, phrase macros (multi-part prompt sequencing).
- Other capabilities: valet parking, dial-by-name directory, LCR, DID→gateway lookup, CNAM lookup w/ cache, blacklists, number translation/E.164 normalization, multicast paging, ENUM, weighted distribution, prepaid billing (per-second nibble), user spy, AMD/beep detect, SMS chatplan, HTTP-driven IVR (httapi = webhook call control), key-value store powering redial/*69/intercept state, limit backends (concurrency caps per user/gateway/tenant).
- Endpoints: SIP (sofia: profiles, gateways, in/out registration, presence SUBSCRIBE/NOTIFY/BLF, MWI, MESSAGE, REFER, re-INVITE, SRTP/DTLS, TLS, NAT handling, SIP-over-WS/WSS), loopback (bridge into an app), WebRTC (Verto JSON-RPC alternative).
- Codecs: core G.711 PCMU/PCMA, G.722, L16, GSM, VP8; modules Opus, AMR(-WB), G.729, iLBC, SILK…; default preference OPUS,G722,PCMU,PCMA,H264,VP8.
- Formats: sndfile (wav etc.), local_stream (shared always-running streams = MOH), tone_stream (synthesized ringback/tones), shout (mp3/icecast), http_cache (S3-aware).
- CDR writers: json→HTTP POST, csv, pgsql, odbc.

## 10. Vanilla feature-code map (spec for our feature codes)

*98/4000 voicemail main; *97-style per-user vm; *8 group pickup; 886 global pickup; **ext directed pickup; *69/869 call return; 870 redial; *0/88xxxx eavesdrop/barge; *1 dx transfer, *2 record toggle, *3 conference, *4 att_xfer (in-call meta keys); 5000 IVR demo; 5900/5901 park/unpark; 6000/60xx valet lots; 30xx-38xx conference rooms by quality; 8xxx intercom (auto-answer); 2000-2002 group dials; 7243 paging; 9178/9179 fax rx/tx; 9180-9184 ringback/early-media test; 9195-9198/9664 echo/tone/MOH tests; 0 operator.

## 11. Complete-backend checklist (67 items, tiered)

**T0 (1-15):** SIP signaling (REGISTER digest, INVITE/ACK/BYE/CANCEL, re-INVITE, OPTIONS, UDP/TCP/TLS) · SDP offer/answer + codec negotiation · RTP w/ jitter buffer, RTCP, NAT auto-adjust, timeouts · G.711+Opus (+G.722) + transcoding · UUID sessions + state machine · legs + bridging (incl. bypass) · routing engine (ordered rules, regex, captures, continue) · user directory (domains/users/creds/groups/per-user vars) · internal vs external profile separation (security boundary) · gateways w/ failover + OPTIONS ping + state · hangup-cause taxonomy · 180/183/200 + ringback/MOH-ringback · DTMF (2833/INFO/inband; queue; collection) · play/record files w/ silence detect · CDR per leg.
**T1 (16-40):** ext-to-ext w/ vm fallback · voicemail (full) · IVR (menus, greet long/short, digit len, regex entries, submenus, timeouts/max-failures, invalid/exit sounds) · blind+attended transfer (incl. REFER) · hold/MOH shared stream · forward always/busy/no-answer/unregistered + DND · ring groups (sim/seq, per-leg timeout, confirm, lose-race) · group dial · conferences · ACD queues (full) · park (simple+valet) · pickup (directed/group/global) · recording (on-demand/always/pause/mask) · DID routing → any destination type · outbound routes (E.164 normalize, toll classes per user, trunk failover) · caller-ID (internal vs external, privacy, P-Asserted-Identity, CNAM) · presence/BLF (dialog-info, device-state aggregation; park+queue BLF) · **event stream + external call-control API (the programmability keystone)** · originate/click-to-call API · variable scopes · CIDR ACLs + registration/INVITE rate limits + fail2ban events · concurrency limits (user/gateway/tenant) · business-hours routing first-class · multi-tenant domain scoping · dynamic config w/ cache+invalidation contract.
**T2 (41-60):** WebRTC (WS/WSS SIP or JSON-RPC; DTLS-SRTP, ICE/STUN/TURN) · TLS+SRTP policy + secure indication · TTS/ASR plugin surface + barge-in · intercom/paging · eavesdrop/whisper/barge · fax T.38 · LCR · prepaid billing hooks · black/allowlists · dial-by-name · call return/redial state · scheduled actions on live calls · queue-position announcements · whisper-on-answer · audio inject into live call · multi-language phrase system · SMS routing · scripting/plugin surface · video/SFU · SLA/boss-admin · call recovery/HA.
**T3 (61-67):** UUID-correlated logging + per-session log level + SIP trace + media stats (MOS/jitter/loss) on hangup · `show channels/calls/registrations` equivalents + heartbeat · loop protection (max forwards, loop detect) · NAT traversal (rport, contact rewrite, keepalive pinholes; media auto-adjust, STUN/TURN) · per-profile/user codec policy + renegotiation · graceful drain shutdown · config reload without dropping calls.

**Build order recommendation:** T0 1-15 → 16-20 → 33/34 (event stream + originate API early — everything else builds on them) → 22-28 → 29-32 → 36-40 → T2.
