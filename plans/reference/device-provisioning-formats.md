# Device provisioning formats (v1 catalogue, frozen 2026-08-06)

What `apps/api/src/provisioning/catalog/templates/*` relies on, where it came from, and what is not
yet proven. This exists because a provisioning template is wrong in a way no test in this repository
can detect: the only real oracle is a handset. Writing down what was verified, what was inferred and
what two vendor documents disagree about is the difference between a follow-up somebody can act on
and a bug somebody rediscovers.

**Scope.** Yealink, Poly/Polycom, Grandstream, Fanvil, Snom + a softphone pattern — the five that
`plans/reference/fusionpbx-inventory.md` §2 identifies as ≈80% of the installed base, replacing
FusionPBX's ~300 hand-maintained model directories with a data-driven catalogue (§6, T3).

**Nothing below has been rendered into physical hardware in this repository.** Every template
carries that caveat in its `caveats` array, which `GET /api/v1/provisioning/catalog` serves to the
admin UI so an administrator reads it before buying forty phones.

---

## 1. Yealink — Common CFG (`.cfg`, `key = value`)

| | |
|---|---|
| Format | Plain text, `key = value`, `#` comments |
| Preamble | **`#!version:1.0.0.1` on line 1 — mandatory in every `.cfg` and `.boot`** |
| Per-MAC filename | `<mac>.cfg`, lower case, 12 hex, no separators |
| Per-model common file | `y0000000000xx.cfg` — `66` T46S, `96` T54W, `97` T57W, `107` T43U, `108` T46U, `109` T48U, `28` T46G, `35` T48G (we do not use these) |
| User overrides | `<mac>-local.cfg`, written BY the phone |
| Content type | `text/plain` |

The banner is a **configuration-format** version, not a firmware version. Its absence is the single
most common reason a hand-written Yealink file appears to be ignored: the phone fetches it, parses
nothing, and reports nothing.

Model scoping inside a file is `[T46S,T48S]param = value`. Static parameters carry a `static.`
prefix and are excluded from the user-override protection mechanism.

### Account N (N = 1…16 on T57W/T54W/T48x/T46x; server index is 1–2)

```
account.1.enable                       = 1
account.1.label                        = Reception
account.1.display_name                 = Alice Nguyen
account.1.auth_name                    = 1001
account.1.user_name                    = 1001
account.1.password                     = …
account.1.sip_server.1.address         = pbx.example.com
account.1.sip_server.1.port            = 5060
account.1.sip_server.1.transport_type  = 0
account.1.sip_server.1.expires         = 3600
account.1.shared_line                  = 0
account.1.outbound_proxy_enable        = 1
account.1.outbound_proxy.1.address     = sbc.example.com
account.1.outbound_proxy.1.port        = 5060
account.1.subscribe_mwi                = 1
account.1.voice_mail.number.1          = 1001
```

Two names that are easy to get subtly wrong:

- **`transport_type`, not `transport`** — `0` UDP, `1` TCP, `2` TLS, `3` DNS-NAPTR.
- **`outbound_proxy.1.address` / `.port`** — an indexed sub-object, not an `outbound_host` /
  `outbound_port` pair.

`expires` is **seconds** (30–2147483647, default 3600). `shared_line`: `0` private, `2` BLA.

### Keys — three namespaces, and the one place our schema does not map cleanly

`linekey.N.*` (the DSS column beside the screen), `programablekey.N.*` (hard keys — **single m**,
Yealink's spelling), `expkey.N.*` (expansion module). All 1-based.

```
linekey.2.type      = 16
linekey.2.line      = 1
linekey.2.value     = 200
linekey.2.label     = Sales
linekey.2.extension = *97
```

Verified V86 `type` codes: `15` Line, `16` BLF, `13` Speed Dial, `14` Intercom, `10` Call Park,
`39` BLF List, `2` Forward, `5` DND, `7` Recall, `12` Voice Mail, `23` Group Pickup, `24` Multicast
Paging, `27` XML Browser, `42` ACD, `73` Custom Key.

**There is no separate "memory key" namespace on this firmware line** — a BLF lives on a `linekey`
exactly as a line does. So our `line` and `memory` categories both render to `linekey` and share its
index space; a device using both at the same index renders two blocks and the later wins. An
invented offset would silently move an administrator's key to a different button, so the limitation
is left visible and the UI's guidance is one category per Yealink device.

Our `dtmf`, `transfer` and `url` have **no verified code** (the V86 table has no DTMF or Transfer
key type, and `24` is Multicast Paging). They render as `0` (N/A). A dark button is a visible gap
somebody reports; a button wired to `5` because the number looked plausible is a DND key labelled
"DTMF", and nobody reports that as a provisioning bug.

**Caveats.** Codes above ~20 moved between V80 and V84 — this is the V84+ set. With
`static.auto_provision.custom.protect = 1` a provisioned value will not override one the user
changed on the handset.

**Source.** Yealink *Administrator's Guide for SIP-T2/T3/T4/T5/CP92X IP Phones V86.5* — banner,
boot/CFG naming and per-model codes, `account.X.*` table, key namespaces and the numeric type table.

---

## 2. Poly / Polycom — UC Software / Poly Voice XML

| | |
|---|---|
| Format | XML; settings are **attributes** whose names are the dotted parameters |
| Root/nesting | **Decorative** — the phone flattens every attribute it finds |
| Our filename | `<mac>-phone.cfg` |
| Content type | `application/xml` |

Edge E (Poly Voice OS 7.x+) uses the same `reg.x.*` / `attendant.*` / `lineKey.x.*` names as the VVX
line, so one template covers both.

### The two-file bootstrap — read this before deploying

A Poly phone does **not** fetch settings directly. It fetches a **master configuration file**
(`<mac>.cfg`, falling back to `000000000000.cfg`) which is a *manifest*:

```xml
<?xml version="1.0" standalone="yes"?>
<APPLICATION
  APP_FILE_PATH="sip.ld"
  CONFIG_FILES="https://pbx.example.com/provision/<token>/config, site.cfg"
  MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY=""/>
```

`CONFIG_FILES` is read **left to right and the LEFTMOST file wins** a duplicated parameter — the
opposite of most layering schemes. Our URL therefore belongs first if it is to take precedence over
a site-wide file.

There is no supported way to collapse this into one GET. Emitting the settings under `<mac>.cfg` and
hoping produces a phone that fetches the file, fails to parse it as a manifest, and boots to
defaults silently. **This is the one vendor whose deployment needs a second artifact we do not
generate**, and closing that is the highest-value provisioning follow-up.

### Registration N (N = 1…34 on Edge E)

```xml
reg.1.address               = "1001@pbx.example.com"   <!-- Null here DISABLES the line -->
reg.1.label                 = "Reception"
reg.1.displayName           = "Alice Nguyen"
reg.1.type                  = "private"                <!-- or "shared" -->
reg.1.auth.userId           = "1001"
reg.1.auth.password         = "…"
reg.1.server.1.address      = "pbx.example.com"
reg.1.server.1.port         = "5060"
reg.1.server.1.transport    = "UDPOnly"
reg.1.server.1.expires      = "3600"
reg.1.server.1.register     = "1"
reg.1.outboundProxy.address = "sbc.example.com"
reg.1.outboundProxy.port    = "5060"
reg.1.outboundProxy.transport = "UDPOnly"
msg.mwi.1.subscribe         = "1001@pbx.example.com"
msg.mwi.1.callBackMode      = "contact"
msg.mwi.1.callBack          = "1001"
```

**`transport` takes WORDS, case-sensitively**: `DNSnaptr` (default), `TCPpreferred`, `UDPOnly`,
`TCPOnly`, `TLS`. A numeric value is silently ignored — the trap for anyone porting the Yealink
template. Global fallbacks live under `voIpProt.server.1.*`; `reg.x.*` overrides them.

### Keys — two different mechanisms, both positional and dense

- **BLF / presence** is the *attendant* feature: `attendant.reg="1"` plus
  `attendant.resourceList.N.{address,label,type}` with `type` = `normal` or `automata`. The
  alternative is a server-side BLF list via `attendant.uri`, which makes `resourceList` ignored.
- **A key that dials** is an *enhanced feature key*, and it is **two halves**: an `efk.efklist.N.*`
  entry defining the macro and an `efk.efksoftkey.N.*` entry putting it on a key, both gated on
  `feature.enhancedFeatureKeys.enabled="1"`. Emitting only the second binds a key to a macro that
  does not exist. `action.string` uses the macro language — `1002$Tinvite$` means "call 1002";
  without `$Tinvite$` the key types digits into the dial field and waits.
- Positional control is available through Flexible Line Keys (`lineKey.reassignment.enabled`,
  `lineKey.x.category` = `Line`|`BLF`|`SpeedDial`|`EFK`|`Presence`|`Unassigned`), which this build
  does not use.

**Caveats.** EFKs occupy soft keys, not the line-key column — physical placement will not match a
Yealink of the same layout. Polycom's other speed-dial mechanism is a contact-directory file
(`<mac>-directory.xml` with `<sd>N</sd>`) that this build does not generate. The phone **writes**
`<mac>-phone.cfg` and `<mac>-web.cfg` override files, so a provisioned value can appear ignored when
one exists.

**Sources.** Poly *UC Software 6.4.0 Administrator Guide*; Poly *Voice Software Administrator Guide*
(Edge E); Polycom *Provisioning with the Master Configuration File*; Poly UC Software parameter
reference.

---

## 3. Grandstream — `gs_provision` XML

| | |
|---|---|
| Root | **`<gs_provision version="1">`** — never `gs_config` |
| Dialect used | **`<config version="2">`** (alias) |
| Filename | `cfg<mac>.xml` |
| Content type | `application/xml` |

Request order, first match wins:

```
cfg<mac>.xml → cfg<mac> (binary) → cfg<model>.xml → cfg.xml → dev<mac>.cfg → external.cfg
```

MAC lower case, 12 hex. `P8467` ("download and process ALL available config files") inverts this and
applies every one, later overriding earlier. An optional `<mac>` element as a sibling of `<config>`
is **validated** by the phone when present, so a configuration served to the wrong handset is
refused rather than applied — worth having on a token-addressed URL. We emit it.

### The two text dialects

| `<config version>` | Dialect | Example |
|---|---|---|
| `1` | P-value | `<P271>1</P271>` |
| `2` | Alias | `<item name="account.1.sip.server.1.address">pbx</item>` |

**Mutually exclusive.** Mixing them, or leaving `version="1"` while writing alias names, produces a
document the phone silently ignores.

### Why the alias dialect — two reasons, the second decisive

**1. P-values are irregular.** Accounts 2–4 are blocks based at `(N + 2) × 100` (account 2 → 400):

| Parameter | Acct 1 | Offset in blocks 2–4 |
|---|---|---|
| Account Active | P271 | +1 |
| SIP Server | P47 | +2 |
| Outbound Proxy | P48 | +3 |
| SIP User ID | P35 | +4 |
| Authenticate ID | P36 | +5 |
| Authenticate Password | P34 | +6 |
| Display Name | P3 | +7 |
| SIP Registration | P31 | +10 |
| Register Expiration | P32 | +12 |
| Local SIP port | P40 | +13 |
| Account Name | P270 | +17 |
| Transport (0 UDP / 1 TCP / 2 TLS) | P130 | +48 |

VPK key 1 is `P1363` (mode) / `P1364` (account) / `P1465` (description) / `P1466` (value), stride
`+2` per pair. MPK key 1 is `P323` / `P301` / `P302` / `P303`. Extension board is `P23000`–`P23003`,
stride `+4`. **Accounts 5–16 (GRP2650) have no confirmed P-block at all.**

**2. The VPK `mode` integer scale is ambiguous, and both sources are Grandstream's.**

| Source | Line | Speed dial | BLF |
|---|---|---|---|
| GXP21xx administration guide, Table 24 (fixed line VPKs) | 0 | 10 | 11 |
| Dynamic-VPK/MPK scale in Grandstream's own template annotations | 31 | 0 | 1 |

Third-party documentation disagrees with both. A template that picks one is wrong on half the fleet
and wrong in the worst way — a key that lights up as the *wrong feature* rather than not at all.
Current firmware accepts **case-insensitive string** mode names, so the conflict is avoided rather
than resolved. **Resolving it needs hardware**; until then no P-value template should be written.

### What we emit

```xml
<gs_provision version="1">
  <mac>001565abcdef</mac>
  <config version="2">
    <item name="account.1.enable">Yes</item>
    <item name="account.1.name">Reception</item>
    <item name="account.1.sip.server.1.address">pbx.example.com</item>
    <item name="account.1.sip.userid">1001</item>
    <item name="account.1.sip.subscriber.userid">1001</item>
    <item name="account.1.sip.subscriber.password">…</item>
    <item name="account.1.sip.subscriber.name">Alice Nguyen</item>
    <item name="account.1.sip.registration">Yes</item>
    <item name="account.1.sip.transport">UDP</item>
    <item name="account.1.sip.registerExpiration">60</item>
    <item name="account.1.sip.outboundProxy.1.address">sbc.example.com</item>
    <item name="pks.vpk.1.keyMode">BLF</item>
    <item name="pks.vpk.1.account">0</item>
    <item name="pks.vpk.1.value">1002</item>
    <item name="pks.vpk.1.description">Ben</item>
  </config>
</gs_provision>
```

Three device-facing traps, all handled:

1. **`registerExpiration` is MINUTES** (1–64800, default 60). A `3600` there is a 60-hour
   re-registration interval, which works until the first NAT binding expires and then presents as
   "inbound calls stop after a while".
2. **A VPK's `account` is 0-indexed** while account parameters are 1-indexed. Line 1 → `0`.
3. **Dynamic VPKs must be contiguous** — a gap deletes every later key — so a key's slot is its
   position among configured keys, not its `keyIndex`. The one vendor here where that is true.

A non-default registrar port goes into `sip.server.1.address` as `host:port`;
`account.N.sip.localPort` (P40) is the phone's own listener and is emphatically not it.

`account.N.sip.transport` accepts `UDP` / `TCP` / `Tls Or Tcp`, or 0/1/2.

Whole-file AES-256-CBC encryption is supported; the decryption password is **P1359** (the
provisioning guide prints "P1349" once — that is a typo).

**Sources.** Grandstream *SIP Device Provisioning Guide*; *GRP261x/262x/263x Administration Guide*;
*GXP21xx Administration Guide* Table 24; Grandstream-authored configuration templates.

---

## 4. Fanvil — `<<VOIP CONFIG FILE>>` sectioned text

| | |
|---|---|
| Format | Sectioned plain text, **CRLF throughout** |
| Preamble | **`<<VOIP CONFIG FILE>>Version:<n>` — mandatory, line 1** |
| Terminator | **`<<END OF FILE>>` — mandatory** |
| Separator | a colon (space padding before it is cosmetic) |
| Filename | `<mac>.cfg` (URL token is the literal `$mac`) |
| Content type | `text/plain` |

Chosen over Fanvil's `<sysConf>` XML dialect because it is the format Fanvil's own exported backups
use, so an administrator can diff what we produce against what their phone produces — the most
useful debugging affordance a provisioning system can offer, and the recommended remedy for the
unverified key encodings below.

Per-model common files are fixed and unchangeable: X5S `F0V0X5S00000.cfg`, X6 `F0V00X600000.cfg`,
X7 `F0V00X700000.cfg`, X210 `F0VX21000000.cfg`, X3S `f0X3Shw1.100.cfg`, X4 `f0X4hw1.100.cfg`.

### The version string is a CHANGE MARKER, not a format version

**The phone will not re-apply a file whose version string has not changed since the last fetch.** A
constant `Version:2.0000` therefore means the configuration applies exactly once, ever — including
after a real edit, which then appears to have been ignored. Observed values are decimal and vary in
length (`2.0002`, `2.0003`, `2.0000000000`).

Our template derives it: `2.` plus ten decimal digits of a SHA-256 over the rendered body. An
unchanged device renders an unchanged version and the phone does nothing (no spurious reboot); any
real change moves it. Collision probability ≈ 1 in 10¹⁰, and a collision costs one skipped update
rather than a wrong configuration.

### Structure

Section headers use **single** angle brackets and are **never closed** — a module runs until the
next module header. There is no `</SIP CONFIG MODULE>`.

```
<<VOIP CONFIG FILE>>Version:2.0000123456

<SIP CONFIG MODULE>
SIP1 Enable Reg :1
SIP1 Phone Number :1001
SIP1 Display Name :Alice Nguyen
SIP1 Register Addr :pbx.example.com
SIP1 Register Port :5060
SIP1 Register User :1001
SIP1 Register Pswd :…
SIP1 Register TTL :3600
SIP1 Transport :0
SIP1 Proxy Addr :sbc.example.com
SIP1 Proxy Port :5060

<DSSKEY CONFIG MODULE>
Fkey1 Type :2
Fkey1 Value :SIP1
Fkey1 Title :Reception
Fkey2 Type :1
Fkey2 Value :1002@1/bc
Fkey2 Title :Ben

<<END OF FILE>>
```

`SIPn Transport`: `0` UDP, `1` TCP.

### DSS keys have a shape no other vendor here shares

A key is exactly four fields — `Type`, `Value`, `Title`, `ICON` (colour models only). **There is no
`FkeyN Subtype` parameter**, however much the web UI implies one. `Type` is numeric: `0` None,
`1` Memory key, `2` Line, `3` Key Event, `4` DTMF, `7` URL, `13` BLF List, `14` Multicast,
`20` Action URL, `21` XML browser.

**BLF, speed dial, presence, intercom and call park are ALL `Type = 1`**, and the distinction rides
inside `Value` as `<number>@<line>/<subtype>` — `1002@1/bc` for a BLF on line 1. A line key is
`Type = 2` with `Value = SIP<n>`.

**Caveats.**

- **UNVERIFIED:** the TLS transport integer is `2` on the X3S/X4 generation and `3` on
  X5S/X6/X210/X7/XU in Fanvil's own sheets. We write `2`; a newer-generation deployment overrides
  `SIPn Transport` through the settings cascade until this is settled on hardware.
- **UNVERIFIED:** only `bc` (BLF) is corroborated from a working template. `park`, `intercom` and
  `transfer` render as `Type 0` (None) rather than a guessed subtype letter. Configure one of each
  in the phone's web UI, export, and read back the exact `Value` strings.
- Models with a separate expansion module index those keys under a prefix we do not emit.
- Fanvil's XML dialect is `<sysConf>` with `<line index="1">` children whose element names are the
  text parameter names with spaces stripped; a FusionPBX note says it is "optimized for firmware
  2.2.10 and newer — older firmware has incorrect tag names".

**Sources.** Fanvil *Auto Provision Description*; Fanvil X-series parameter spreadsheet; BroadSoft
*Partner Configuration Guide, Fanvil*; Fanvil-authored provisioning templates.

---

## 5. Snom — `<settings>` XML

| | |
|---|---|
| Format | XML; the **index is an attribute**, not part of the element name |
| Root | `<settings>` with `<phone-settings>` and `<functionKeys>` children |
| Our filename | `<mac>.xml` |
| Content type | `application/xml` |

The Setting URL supports `{mac}`, `%MACD`, `{phone_type}` and `{firmware_version}`. **If the
configured filename lacks `{mac}` the phone also requests a `-<MAC>` variant** (`test.xml` → also
`test-000413920A74.xml`), so plan the server route for both. `<firmware-settings>` must NOT be
nested inside `<settings>`.

```xml
<?xml version="1.0" encoding="utf-8"?>
<settings>
  <phone-settings>
    <user_active   idx="1" perm="RW">on</user_active>
    <user_realname idx="1" perm="RW">Alice Nguyen</user_realname>
    <user_name     idx="1" perm="R" >1001</user_name>
    <user_pname    idx="1" perm="R" >1001</user_pname>
    <user_pass     idx="1" perm="R" >…</user_pass>
    <user_host     idx="1" perm="R" >pbx.example.com</user_host>
    <user_outbound idx="1" perm="R" >pbx.example.com:5060;udp</user_outbound>
    <user_expiry   idx="1" perm="RW">3600</user_expiry>
    <user_srtp     idx="1" perm="RW">off</user_srtp>
  </phone-settings>
  <functionKeys>
    <fkey idx="0" context="1" label="Ben" perm="RW">blf sip:1002@pbx.example.com;user=phone</fkey>
  </functionKeys>
</settings>
```

Three Snom-specific things that cost a day each:

1. **`idx` bases differ.** Identities (`user_*`) are **1-based**; function keys are **0-based**. Not
   a typo. Our template decrements for keys so a uniformly 1-based `keyIndex` lands where an
   administrator counted it.
2. **`perm=""` and `perm=" "` mean OPPOSITE things.** Empty (or `$`, `RW`) is user-changeable and
   re-applied on every provisioning; a **single space** (or `&`, `R`) is write-protected; `!` means
   provisioning wins only while the user has never changed it locally — precisely the flag NOT to put
   on credentials, because one touch permanently pins a stale password; `V` (10.1.79+) is volatile.
   We write `R` / `RW`, never the whitespace forms, because a stray trim anywhere in this file's
   lifetime would silently invert every credential's protection.
3. **There is no transport parameter.** The transport is a `;udp` / `;tcp` / `;tls` suffix on
   `user_outbound`. A `user_server_type` does not exist on this firmware line; adding one produces a
   setting the phone ignores while the transport stays at its default. Our template therefore always
   emits `user_outbound`, even with no proxy configured.

An `<fkey>`'s **text** is the whole instruction: a keyword and an optional argument. Documented
keywords: `line`, `blf`, `dest`, `speed`, `icom`, `multicast`, `redirect`, `transfer`,
`keyevent F_…`. BLF takes a full SIP URI with `;user=phone` — a bare extension subscribes to nothing
and the key stays dark. `context` names the identity (1-based) or the word `active`. `dtmf` is not in
the documented set and renders as `none` rather than a guess.

**Sources.** Snom Service Hub — *Desk Phone Configuration Files*, *Permission Flags*,
*`<functionKeys>` tag*, *Auto Provisioning*; BroadSoft *Partner Configuration Guide, Snom 10.1.51.12*.

---

## 6. Softphones and QR

**There is no cross-vendor QR provisioning standard, and the obvious guess is wrong.**

| Client | QR / deep link | What it fetches |
|---|---|---|
| Acrobits (Groundwire, Cloud Softphone) | `csc:user:password@CLOUDID` | an `<account>` XML document |
| Zoiper | an **HTTPS URL** | `<options><accounts><account>` XML |
| Linphone | an **HTTPS URL**, optionally wrapped as `linphone-config:` | lpconfig `<config><section><entry>` XML |

A bare `sip:` URI in a QR code **places a call** in all three — `sip:` (and `groundwire:`,
`zoiper:`) are dial schemes, not provisioning schemes. So our QR encodes the **payload URL**, which
is the model Zoiper and Linphone already use and the only one that degrades sensibly: a client that
does not recognise it shows a link a human can open.

`GET /provision/<token>/payload` returns JSON:

```jsonc
{
  "version": 1,
  "device": { "id": "…", "macAddress": "001565abcdef", "vendor": "softphone", "model": null },
  "accounts": [{ "line": 1, "username": "1001", "authUsername": "1001", "password": "…",
                 "domain": "pbx.example.com", "server": "pbx.example.com", "port": 5060,
                 "transport": "udp", "registerExpiresSeconds": 3600, "voicemailNumber": "1001",
                 "sipUri": "sip:1001:%E2%80%A6@pbx.example.com;transport=udp" }],
  "qr": { "url": "https://…/provision/<token>/payload", "note": "Encode this URL…" }
}
```

`sipUri` is for **manual entry** — the string somebody types or reads out when a desk-phone template
has failed them. Userinfo is `encodeURIComponent`-encoded, which is stricter than RFC 3261 requires;
over-encoding decodes correctly everywhere, under-encoding does not.

**The payload and its URL are credentials.** They contain SIP passwords, and the admin UI treats the
QR exactly as it treats the provisioning URL.

**Follow-up.** Per-client documents, one template each with its own id: Acrobits `<account>` XML
(also needs a Cloud Softphone id this product does not have), Zoiper `<options>` XML, Linphone
lpconfig `<config>`.

**Sources.** Acrobits documentation (initial screens / `csc:`, Account XML, call URIs); Zoiper OEM
token-based provisioning; liblinphone provisioning fixtures and the linphone-android changelog;
RFC 3261 §19.1.

---

## 7. What is not proven

| Item | Status |
|---|---|
| Every template, end to end | **Not rendered into physical hardware.** |
| Grandstream VPK integer `mode` scale | Two Grandstream documents conflict. Avoided via string names; unresolved. |
| Grandstream P-value dialect | Table recorded above; no template written. Accounts >4 unconfirmed. |
| Poly master `CONFIG_FILES` manifest | Documented above; **not generated by this build**. |
| Fanvil TLS transport integer | 2 vs 3, model-dependent, both in Fanvil's own sheets. We write 2. |
| Fanvil memory-key subtype letters | Only `bc` (BLF) corroborated. Others render as Type 0. |
| Yealink key-type codes >20 | V84+ set; V80 differs. |
| Yealink `line` vs `memory` categories | Both map to `linekey`; they share an index space. |
| Snom fkey keyword completeness | No single official page enumerates them; `dtmf` unconfirmed. |
| Acrobits `provlink://` / `provlinkbs://` | Field-observed in FusionPBX templates, undocumented. |
| Zoiper `o` / `x` / `tr` QR query parameters | Partially documented. |
| The derived SIP password | `apps/api/src/provisioning/render/provision-secret.ts` defines the derivation; **no registrar consumes it yet**. |
