# Telephony Ecosystem Research (verified 2026-08-05)

Primary-source-verified (go.mod / build.gradle / package.json / GitHub API / LICENSE) survey informing the media/signaling decision in the master plan.

## Headline conclusions

1. **No production pure-TypeScript media plane exists.** Universal pattern: TS/Python/Go control over native media. werift-webrtc is the only genuine pure-TS ICE/DTLS/RTP/SRTP stack — no production voice deployment found. → Pure-TS RTP rejected for us.
2. **2026 consensus media plane is Go + Pion** — LiveKit SIP and jambonz "mediajam" converged on it independently.
3. **Signaling and media stay separated everywhere**; signaling on battle-tested proxies (Kamailio/OpenSIPS/drachtio/JAIN-SIP).
4. Two teams concluded FreeSWITCH is too heavy for modern voice in the same year (jambonz benchmarks: mediajam ~750 concurrent sessions vs ~290 FS on 4 vCPU; 39MB vs 494MB base).
5. Open-core is the norm now; fully open AND healthy: Asterisk, Kamailio, OpenSIPS, rtpengine, mediasoup.

## Key projects

- **LiveKit SIP** (Go, Apache-2.0, daily activity; $100M Series C; transport behind ChatGPT voice): sipgo fork + Pion (rtp/srtp/sdp/webrtc/ice/dtls/turn); G.711, G.722, Opus, AMR-WB. SIP UDP/TCP/TLS, SRTP, DTMF 2833/4733, REFER transfers, OPTIONS. **No SIP REGISTRAR** (desk phones can't register; outbound-REGISTER PR open), no SIPREC, no video-SIP. Model: trunk → dispatch rules → room; agents join as WebRTC participants. Needs Kamailio/OpenSIPS/Routr in front for a PBX.
- **jambonz**: OSS 0.9.x line = drachtio-server (C++/sofia-sip, MIT) + rtpengine + FreeSWITCH + Node feature-server (MIT; frozen features, fixes through 2026). Commercial 11.0 (2026-07) replaced FreeSWITCH with **mediajam** — closed-source Go media server (Pion RTP; PCMU/PCMA/Opus/G.722 + telephone-event; bridging/conferencing/file+HTTP playback; control = newline-JSON over TCP via public MIT client `@jambonz/mrf`). Named users: Cognigy, Rasa, Vapi.
- **Routr** (our current edge): TS logic + Java JAIN-SIP signaling core in-proc via GraalVM; EdgePort→gRPC→stateless processors; Redis/in-mem location; drives rtpengine; Asterisk/FS as balanced Peers. MIT. **Commit velocity down ~88% vs 2024** → contain and plan replacement.
- **AI-voice platforms**: Vapi = own SBC, media via Daily WebRTC (+jambonz customer). Retell = LiveKit Cloud. Bland = BYO telephony. Pipecat (Daily, Python) = no native SIP. OpenAI Realtime SIP = inbound-only TLS/SRTP. ElevenLabs = native SIP trunking + LiveKit integration. → LiveKit/Pipecat are the default AI-voice stacks.
- **Rust rising** (watch list): str0m, rsipstack, rustpbx (~5k concurrent RTP calls claimed on 3.8 cores). Not adoption targets yet.

## Engine health (Aug 2026)

- **FreeSWITCH**: public tree near-dormant (77 commits/52wk; 1,192 open issues; ~29-month advisory blackout ended with two pre-auth CRITICALs Jun 2026: mod_verto heap overflow, libesl heap overflow). License still **MPL 1.1** (not GPL-compatible; never moved to 2.0). Package repo token-gated since 2022; Enterprise branch paywalled (v20.25.x). Current OSS line 1.11.x (May 2026) after 21-month gap; ~30 legacy modules removed. → Validates removal; do not build on it.
- **Asterisk**: 22 LTS is the target (full support to 2028-10, EOL 2029-10); 20 LTS security-only from **2026-10-19** (we run 20 → upgrade). 289 commits/52wk, groomed issues, RC discipline; chan_sip removed in 21 (PJSIP only); big coordinated security batch 2026-06-25 (funded fuzzing — health signal). Risks: contributor concentration; Sangoma finances thin.
- **Kamailio**: healthiest of all (1,492 commits/52wk; 6.1.x). **OpenSIPS** 4.0 (TCP/TLS rewrite). **rtpengine** very active (GPL-3.0). **mediasoup** 3.24 healthiest SFU (ISC). **Janus** maintenance. **drachtio** alive, single-maintainer risk.
- Trap flagged: distrust "we own the whole stack" vendor claims.

## Deep-dive corrections & library facts (second research pass)

- **rtpengine does NOT conference-mix**: no rooms, no per-participant mix-minus, no speaker selection (`mix` flag explicitly "doesn't enable actual audio mixing"; recording `--output-mixed` = first 4 SSRCs). Real conference bridges are only: FreeSWITCH mod_conference, **Janus AudioBridge** (8-48kHz mixing, direct G.711 participants, plain-RTP joins, per-participant RNNoise, mix recording), **Asterisk ConfBridge**. Any Kamailio/drachtio+rtpengine architecture therefore needs a third process for conf/IVR/MOH/voicemail — exactly the shape jambonz ran for six years.
- rtpengine strengths confirmed: transcoding G.711/G.722/G.723.1/G.729(free via libbcg729)/GSM/iLBC/Speex/Opus/AMR/EVS, media playback, MOH, bidirectional DTMF transcoding, T.38 gateway, recording w/ pause/resume, JSON-over-WS control, in-kernel forwarding.
- **Why Node can't pace RTP**: not throughput — tail latency. V8 major GC can stall dozens-to-hundreds of ms; setInterval drifts ~12ms/30s (schedules from callback completion). ~15-25 concurrent calls/single Node process before stutter vs 250-400/core native. Event-loop lag >40ms = underruns against the fixed 20ms frame deadline.
- **Codecs in JS (2026)**: G.711 trivial (lookup table, ~0.004% core/stream). **Opus via WASM is near-native now** — `libopus-wasm` 0.2.0 (MIT, libopus 1.6.1, Node 22+, zero node-gyp) within ~3-7% of `@discordjs/opus`, ~306× realtime/core, includes PLC/FEC (the only PLC available in JS). **No pure-JS G.722** (only native `g722-spandsp`), **no JS G.729**, no RFC 3389 comfort noise, no NetEq. werift = video-oriented (Opus only audio, no PCMU/PCMA, reorder-only jitter buffer) — protocol library, not a telephony audio path.
- **LiveKit SIP further weakened as PBX**: trunks are PCMU/PCMA/G722/AMR-WB only (no Opus, open FR), per-SIP-leg mixing is O(n²) per conference, `@livekit/rtc-node` officially "not ready for production", egress = headless Chrome + GStreamer at 0.5-3.0 CPU/job.
- **Client libraries to use**: `@audc/rtpengine-client` 0.6.0 (not the dormant rtpengine-client), `esl-lite` 3.2.0 or `drachtio-modesl` 2.0.1 if ESL ever needed, `ari-client` 2.2.0 (stale but fine — ARI REST is versioned/stable; `@types/ari-client` 2.2.14 current), `janode` for Janus, `drachtio-fsmrf` 5.0.1.
- Precise versions: Asterisk 22.10.1 LTS / 23.4.1 (2026-06-25). FreeSWITCH 1.11 removed ~30 modules + moved to PCRE2; mod_g729 is a paid SignalWire license (rtpengine's is free).
- **The proven seam**: PCM-over-WebSocket/TCP (our AudioSocket) is where TS touches audio _content_ without pacing packets — mediajam's drop-in mimicry of the fsmrf surface (faking esl::ready/esl::end so zero Node changes were needed in jambonz v11) is the cleanest demonstration that the control/media split is the right boundary.

## Implications for the plan (see master plan §3.4)

- Media Option A (Asterisk 22 via ARI) is the only choice that keeps every PBX media feature (conf/MOH/park/T.38) solved while we build the TS control plane; revisit LiveKit (AI-voice strength) and Kamailio+rtpengine (telecom-grade) at Phase 6 with traffic data.
- A **TS SIP signaling service is viable** (registrar/auth/location have no realtime-audio constraints) as the Routr replacement path; media in TS is not.
- Registration/location state must live in Redis so the SIP edge is swappable.
