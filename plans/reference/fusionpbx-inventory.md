# FusionPBX Feature & Data-Model Reference (frozen 2026-08-05)

Extracted from the vendored FusionPBX PHP source (upstream master @ e831b97) before deletion. This is the product feature spec for the Next.js admin + TS backend. PHP code, `v_` schemas, and the declarative-diff migration pattern must NOT be copied — only the domain knowledge.

## 1. Scale

77 app modules + 20 core subsystems, ~110 tables (UUID PKs, insert/update audit columns), 3-level settings cascade, ~940 fine-grained permissions, 29-vendor provisioning template library (~300 model folders, ~947 provision settings).

## 2. Feature inventory by area

### PBX call routing (rebuild as first-class entities)

- **Extensions** (~55 cols — trim to ~25): number, alias, password, accountcode, effective/outbound/emergency caller-id name+number, directory visibility, max_registrations, per-ext limits, missed-call action, user_context, toll_allow, call_timeout, record policy, hold music, DND, forward all/busy/no-answer/not-registered (+destinations), follow_me link, language/voice, codec string override, enabled. Linked: extension↔users, per-extension settings.
- **Destinations (DIDs)**: number/regex, caller-id overrides, cid-name prefix, context, record flag, hold music, distinctive ring, ringback, accountcode, usage flags (voice/fax/emergency/text), conditions/actions (primary + alternate), order, email.
- **Dialplans**: central rule table (context, name, number, order, continue, XML details rows tag=condition/action/anti-action) — every feature compiles into it; inbound/outbound routes are filtered views. OUR REBUILD: features stay first-class, a Routing Compiler generates the runtime artifact.
- **Time conditions** (dialplan-row backed upstream — give it a real table), **Ring groups** (strategy sim/seq/enterprise/rollover, per-destination delay+timeout, timeout action, users), **IVR menus** (greet long/short, TTS, digit length, direct dial, timeouts, nested via parent_uuid, options rows), **Call flows** (day/night toggle + BLF feature code), **Follow-me** (+destinations), **Call forward/DND** (writes extension flags via ESL), **Call block** (CID black/allowlist), **Call broadcast** (campaigns — skip v1), **Feature codes** (star-code catalog), **Click-to-call** (ESL originate), **Pin numbers** (outbound auth codes), **Number translations** (regex digit manipulation rulesets applied to gateways/routes), **Bridges** (named dial-string aliases).
- **Voicemail**: boxes (per extension), messages, options (digit→destination during greeting), copy-to destinations, greetings, transcription, email delivery.
- **Conferences**: static rooms + conference centers (multi-room, PINs, sessions + session-detail logs) + profiles/controls (DTMF maps). Ship ONE model (centers).
- **Queues/ACD** (mirrors mod_callcenter): queues (~40 cols: strategy, MOH, time-base score, max-wait, max-wait-no-agent, tier rules apply/wait-sec/no-agent-no-wait/wait-multiply-level, timeout action, discard-abandoned-after, abandoned-resume, announce position/sound/frequency, exit keys, record template), agents (callback type, contact, status, max-no-answer, wrap-up, reject/busy delays), tiers (agent×queue, level, position). Plus simpler FIFO (skip v1).
- **Fax**: virtual fax servers (T.38), fax↔users, files inbox/outbox, logs, send queue with retry, email-to-fax (mailbox poller) + fax-to-email.
- **Music on hold** (per-domain streams/categories), **Recordings** (prompt library), **Streams** (icecast/HTTP audio), **Phrases** (multi-part prompt macros).
- **Emergency**: E911 notification + logs (Kari's Law / RAY BAUM'S — must-have).

### Devices & provisioning

- **Devices**: MAC-addressed, vendor/model, template, profile link; **lines** (line#, server addresses, auth id, password, port/transport, register expires, shared-line); **keys** (category, type BLF/speed-dial/line, line#, value, label, icon); per-device settings; **device profiles** = reusable key/setting templates; vendor + vendor-function catalogs (with per-group ACLs).
- **Provision endpoint**: UNAUTHENTICATED HTTP upstream (resolve by MAC/UA/IP, render vendor template with cascade default→domain→device_profile→device) — our rebuild MUST authenticate (per-device token in URL + optional IP ACL).
- Vendors templated upstream (29): aastra acrobits algo atcom avaya cisco digium escene fanvil flyingvoice grandstream groundwire htek linksys linphone mitel obihai panasonic poly polycom sangoma sipnetic snom spectralink swissvoice telekonnectors vtech yealink yeastar zoiper. **v1 scope: Yealink, Poly(+Polycom), Grandstream, Fanvil, Snom (≈80% installed base) + softphone QR (acrobits/groundwire/zoiper pattern).** Upstream templates are MPL-licensed `{$var}` XML/cfg — reusable as data with a new renderer.

### Switch infra (platform-operator surface, not tenant surface)

SIP profiles + per-profile settings + profile↔domain aliasing; sofia global settings; **Gateways/trunks** (register/auth, proxy, register-proxy, from-user/domain, expire, retry, ping min/max, caller-id-in-from, codec prefs, channels cap, context, profile); ACLs (CIDR allow/deny nodes); global vars; module manager; domain limits (per-tenant channel/extension caps → SaaS metering).

### Live monitoring (ESL-read, no persistence upstream → Redis+WS for us)

Active calls, registrations, sip status, active conferences, call-center live (agents/tiers), FIFO list, operator panel (BLF grid), system status, log viewer.

### Reporting & audit

- **CDR (v_xml_cdr ~90 cols — trim to ~40 + JSONB)**: sip_call_id, accountcode, direction, context, caller id/name, destination, start/answer/end epochs, duration/billsec (+ms), hold_accum, bridge_uuid, codecs, remote media ip, record path/name/length, transcription, leg, originating_leg_uuid, pdd_ms, MOS, last_app/arg, missed flag, digits_dialed, pin, disposition, hangup cause + q850 + sip disposition, call_flow JSON; call-center satellite block (queue joined/answered/terminated/canceled epochs, agent, bridged, cancel reason); conference block; ring_group_uuid; ivr_menu_uuid. Satellites: json, flow, logs, transcripts. NEEDS partitioning/archival day one.
- Call recordings browser (disk files indexed via CDR — ours: S3 + table + retention).
- Email queue + attachments + sender job; email templates (per-domain, per-language: voicemail/fax/missed-call/reset).
- Event guard (fail2ban-style SIP attack log); database transactions (change audit); user logs (login audit).

### Core subsystems

Auth (password + LDAP + TOTP plugins, remember-me, CSRF), users (+API keys, TOTP), groups→group_permissions→user_groups, permissions registry, **domains (tenant; parent_uuid hierarchy for resellers)**, default/domain/user settings (the cascade), menu builder (+per-item group ACL, i18n), dashboard widgets, contacts mini-CRM (12 tables — integrate a real CRM instead), notifications, multi-DB registry (read replicas), services registry (daemons), schema-diff upgrader (DO NOT copy — use real migrations), websocket daemon with per-subscriber permission filtering.

## 3. Multi-tenancy model

- `v_domains` = tenant; `domain_uuid` on ~every table; domain resolved by HTTP hostname (admin) / SIP from-host (switch).
- Cross-tenant access via `_domain`/`_all` permission suffixes; superadmin domain selector.
- Global (no domain_uuid): domains, permissions, countries, languages, software, databases, device vendors/functions, menu templates, default_settings, services.
- Settings cascade: default_settings → domain_settings → user_settings (each overrides by name); provisioning additionally device_profile_settings → device_settings. Shape: category/subcategory/name/value/type/order/enabled. ~45 categories; counts: provision 947, theme 66, time_conditions 35, fax 31, voicemail 26, cdr 20, operator_panel 15, extension 14, email 13, ring_group 12, ivr_menu 11, domain 11, users 10…
- OUR UPGRADE: enforce tenancy with Postgres RLS (upstream is app-code-only).

## 4. RBAC

Groups (superadmin/admin/user/agent/fax/manager/public ladder) → per-permission grant rows. ~940 permissions at field/action level (e.g. extension_password, outbound_caller_id_name, xml_cdr ~75 incl. per-column visibility). **Rebuild decision: collapse to `<resource>.<action>[.<scope>]` (~80) + system role templates + ~30 sensitive-field flags (passwords, accountcode, caller-id override, cross-domain, recording access). Decide before building any CRUD UI.**

## 5. FreeSWITCH integration architecture (upstream — informs our engine contract)

1. **Pull config on demand** (Lua XML handler): sections configuration (sofia/acl/callcenter/conference/ivr/local_stream/translate), directory (SIP auth, MWI counts), dialplan, languages — all materialized from DB per request, **memcached with structured keys** (`dialplan:<context>`, `directory:<domain>`, `configuration:<file>:<domain>`), PHP invalidates keys on every save. **The cache-key invalidation contract is the single most load-bearing integration behavior — spec ours before code.**
2. Static bootstrap conf written at install.
3. **ESL push/read** (73 PHP call sites): live state reads + commands (reloadxml, sofia rescan, originate, conference kick/mute/record, agent state, uuid_kill, DND notify).
4. ~40 Lua in-call scripts (IVR, ring groups, follow-me, voicemail, call flows, park/intercept/eavesdrop, DISA, paging, wakeup…) — in our build these become engine feature runtimes in TS.
5. CDR ingestion: mod_json_cdr HTTP POST → parse → tables (+raw JSON).
6. WebSocket daemon fans events to browser with permission filtering (operator panel/active calls).

## 6. Rebuild tiers

- **T0 platform:** tenant model (+hierarchy) w/ RLS; settings cascade service (cached); authn (password+TOTP+API keys+SSO-ready); collapsed RBAC; real migrations; audit log; config-provider w/ cache-invalidation contract; event bus + WS fan-out w/ permission filter.
- **T1 must-have:** extensions; devices/lines/keys/profiles; provisioning (scoped); DIDs; gateways/trunks; inbound/outbound routes as first-class models; routing compiler; IVR; ring groups; time conditions (real table); voicemail full; forward/DND/follow-me; recording + playback/download; CDR + search/export; MOH; prompt library; ACLs; feature codes; email templates/queue; live registrations/calls; E911; event-guard-style protection.
- **T2:** ACD + live dashboards + queue stats; conference centers; operator panel/BLF; call flows day/night; call block; PINs; bridges; number translations; dashboard widgets; domain limits; streams; phrases; click-to-call; fax (verticals).
- **T3 skip/re-scope:** 13 vendor shim apps (→ data-driven catalog); FIFO (dup of ACD); basic_operator_panel (dup); active_calls/calls_active + conferences/conference_centers + dialplan_inbound|outbound view-duplicates (ship one each); raw sofia/vars/modules/tones editing (platform-operator only); log_viewer/system (→ real observability); ~300 provision templates by hand (→ top-5 + QR + redirect services); call_broadcast/wakeup/roku/disa/sla_barge/avmd/nibblebill (niche); installer/upgrader/software (SaaS-obsolete); MySQL/SQLite (Postgres only); countries/languages tables (→ libphonenumber/ICU); contacts CRM (→ integration).

## 7. Highest-risk items (upstream lessons)

1. Device provisioning is the largest surface (947 settings) with real security implications (unauthenticated endpoint upstream).
2. The dialplan compile + cache-invalidation contract determines whether the whole system works.
3. Permission granularity — decide the collapsed model first.
4. CDR write volume — partition + archive from day one.
