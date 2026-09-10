# Recording compliance

This document describes the recording consent controls: what each policy does, which regions the
platform treats as requiring all-party consent by default, how a per-DID override interacts with the
organization default, and what the resulting record is written into.

**This is a configurable policy default, not legal advice.** The region list, the consent policy and
the announcement prompt are settings. They are shipped with defaults that are deliberately
conservative, and they are not a determination that any particular call may or may not be recorded.
Recording obligations depend on where each party actually is, what they were told, what they agreed
to in advance, and on case law that moves. Confirm your obligations with counsel before relying on
these defaults, and change the settings to match the advice you receive.

## Consent policies

The organization setting `recordings.consentPolicy` takes one of three values. It is evaluated once
per call, before any recording tap exists, so a call that does not obtain consent is never recorded
even briefly.

| Policy                          | What happens                                                                                                    | Consent outcome          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `none`                          | Recording starts as configured. No announcement is played.                                                      | `not-required`           |
| `announce`                      | The consent prompt is played to each party in scope, then recording starts.                                     | `announced`              |
| `announce-and-require-keypress` | The prompt is played, then the recorded party must press the accept digit. Recording starts only on acceptance. | `accepted` or `declined` |

Under `announce-and-require-keypress` the accept digit defaults to `1` and the decline digit to `2`;
both are settings. A decline, or no digit within the keypress timeout (10 seconds), is treated as a
decline: **no recording is started**, the start request returns a refusal naming the decline, and the
consent record is still written so the CDR carries the fact that consent was sought and refused.

An all-party jurisdiction match changes two things. It widens the announcement from the recorded
party to **both** parties, and it upgrades a policy of `none` to `announce` for that call. It never
downgrades: a tenant that configured `announce-and-require-keypress` keeps the keypress.

On an **outbound** recorded call the far end is the peer leg, and the announcement goes to both
parties whether or not a jurisdiction matched. The recorded leg there is the tenant's own agent, so
announcing to it alone would tell the recording party about their own recording and tell the
recorded party nothing; the obligation runs to the far end and the tenant placing the call holds it.
Inbound calls are not widened this way — there the recorded leg already is the member of the public,
and the jurisdiction upgrade is what adds the tenant's side.

### What `announced` means, exactly

`announced` means **the media plane reported that it played audio to that party**. `mediad` counts
the milliseconds it actually wrote to that leg's transport and publishes them on `playback.finished`;
a party is recorded as announced to only when that number is greater than zero.

That is a stronger claim than this record used to make. It previously meant "the media plane accepted
a playback", and acceptance is not delivery: a WebRTC party signals its answer before its ICE and
DTLS handshake finishes, and a prompt played into that window is written into a transport with no
peer and discarded. Calls in that state were recorded as announced to while the media plane was
reporting `playedMs 0` on the very same prompt. They are not any more — that party is left out, and
if no party is left the recording is refused.

**It still does not mean the person heard it, and no platform can make that claim.** Audio left the
machine and reached the far end's transport. Whether a human was in the room, whether their handset
was muted at their end, whether they understood the language the prompt is in — none of that is
observable from a telephone network, and a compliance record that implied it would be asserting
something unfalsifiable. Read `announced` as: the platform delivered the disclosure audio to that
party.

Three things back the claim:

- **Readiness gate.** Before playing at a party, the engine waits for that party's leg to report an
  `active` call state, bounded by `consentPeerReadyTimeoutMs` (2 seconds). A leg that has not
  answered cannot be played at, and the media plane may refuse the playback outright.
- **Delivery, not a timer.** After playing, the engine waits for the media plane's own report of what
  it delivered, bounded by `consentPlaybackTimeoutMs` (8 seconds). This replaced a fixed 1500 ms
  sleep that existed only because the engine had no way to know when a prompt had played. The gate's
  cost is now the length of the prompt itself, and a deployment whose parties are all RTP endpoints
  pays nothing extra at all.
- **A party with no evidence is left out.** If readiness expires, or the leg hangs up, or the media
  plane refuses the playback, or the playback never finishes, or it finishes having delivered zero
  milliseconds, that party does **not** appear in `parties`. If that leaves _no_ party at all, the
  recording is refused outright and the call continues unrecorded.

One driver reports no measurement: Asterisk's `PlaybackFinished` carries a playback state and no
duration. On an ARI deployment `announced` therefore falls back to "the playback ended without
failing", which is the strongest evidence that media plane produces. `mediad` — the default — always
reports the number.

## Region mapping

A call's jurisdictions are derived from the caller ID and the destination number, and intersected
with the organization's configured all-party region list. The default list is:

```
US-CA  US-DE  US-FL  US-IL  US-MD  US-MA  US-MI
US-MT  US-NV  US-NH  US-OR  US-PA  US-WA  EU
```

Region codes are ISO 3166-2 for US states and Canadian provinces (`US-CA`, `CA-ON`), ISO 3166-1
alpha-2 for countries (`GB`, `DE`), and the literal `EU` for the European Union. Matching is
case-insensitive, so `us-ca` and `US-CA` are the same setting.

### How a number resolves

A number resolves to a list of regions, most specific first, so a tenant that lists either `US-CA`
or `US` matches a Los Angeles number and the more specific code is the one reported.

- **`+1` (NANP)** — the three-digit area code (NPA) is mapped through a compiled-in table.
  A US NPA yields `US-XX` followed by `US`; a Canadian NPA yields `CA-XX` followed by `CA`.
- **Everything else** — the longest matching country calling code is mapped to its ISO 3166-1
  alpha-2 code. When that country is an EU member state, `EU` is appended: `+49` resolves to
  `["DE", "EU"]`, while `+44` resolves to `["GB"]` alone.
- **Unknown** — a string that is not a valid E.164 number, an absent caller ID, an unassigned NPA and
  an unlisted calling code all resolve to nothing. Nothing then matches, and the tenant's explicit
  policy applies unchanged.

**An area code is an approximation.** Numbers have been portable since 1997 and people move without
changing them, so an NPA is evidence of where a number was once issued and not of where a person is
sitting. It is used because the alternatives are worse — the platform sees the carrier's signalling
address, not the party's location — and the mapping is deliberately biased toward announcing more
often than strictly required, since an unnecessary announcement costs three seconds and a missing one
does not.

### United States

| Region | Area codes                                                                                                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| US-AK  | 907                                                                                                                                                                                     |
| US-AL  | 205, 251, 256, 334, 659, 938                                                                                                                                                            |
| US-AR  | 327, 479, 501, 870                                                                                                                                                                      |
| US-AZ  | 480, 520, 602, 623, 928                                                                                                                                                                 |
| US-CA  | 209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951 |
| US-CO  | 303, 719, 720, 970, 983                                                                                                                                                                 |
| US-CT  | 203, 475, 860, 959                                                                                                                                                                      |
| US-DC  | 202                                                                                                                                                                                     |
| US-DE  | 302                                                                                                                                                                                     |
| US-FL  | 239, 305, 321, 324, 352, 386, 407, 448, 561, 656, 689, 727, 754, 772, 786, 813, 850, 863, 904, 941, 954                                                                                 |
| US-GA  | 229, 404, 470, 478, 678, 706, 762, 770, 912, 943                                                                                                                                        |
| US-HI  | 808                                                                                                                                                                                     |
| US-IA  | 319, 515, 563, 641, 712                                                                                                                                                                 |
| US-ID  | 208, 986                                                                                                                                                                                |
| US-IL  | 217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 861, 872                                                                                                     |
| US-IN  | 219, 260, 317, 463, 574, 765, 812, 930                                                                                                                                                  |
| US-KS  | 316, 620, 785, 913                                                                                                                                                                      |
| US-KY  | 270, 364, 502, 606, 859                                                                                                                                                                 |
| US-LA  | 225, 318, 337, 504, 985                                                                                                                                                                 |
| US-MA  | 339, 351, 413, 508, 617, 774, 781, 857, 978                                                                                                                                             |
| US-MD  | 227, 240, 301, 410, 443, 667                                                                                                                                                            |
| US-ME  | 207                                                                                                                                                                                     |
| US-MI  | 231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989                                                                                                                         |
| US-MN  | 218, 320, 507, 612, 651, 763, 924, 952                                                                                                                                                  |
| US-MO  | 235, 314, 417, 557, 573, 636, 660, 816, 975                                                                                                                                             |
| US-MS  | 228, 601, 662, 769                                                                                                                                                                      |
| US-MT  | 406                                                                                                                                                                                     |
| US-NC  | 252, 336, 472, 704, 743, 828, 910, 919, 980, 984                                                                                                                                        |
| US-ND  | 701                                                                                                                                                                                     |
| US-NE  | 308, 402, 531                                                                                                                                                                           |
| US-NH  | 603                                                                                                                                                                                     |
| US-NJ  | 201, 551, 609, 640, 732, 848, 856, 862, 908, 973                                                                                                                                        |
| US-NM  | 505, 575                                                                                                                                                                                |
| US-NV  | 702, 725, 775                                                                                                                                                                           |
| US-NY  | 212, 315, 329, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934                                                                                 |
| US-OH  | 216, 220, 234, 283, 326, 330, 380, 419, 436, 440, 513, 567, 614, 740, 937                                                                                                               |
| US-OK  | 405, 539, 572, 580, 918                                                                                                                                                                 |
| US-OR  | 458, 503, 541, 971                                                                                                                                                                      |
| US-PA  | 215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878                                                                                                               |
| US-RI  | 401                                                                                                                                                                                     |
| US-SC  | 803, 821, 839, 843, 854, 864                                                                                                                                                            |
| US-SD  | 605                                                                                                                                                                                     |
| US-TN  | 423, 615, 629, 731, 865, 901, 931                                                                                                                                                       |
| US-TX  | 210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979                                              |
| US-UT  | 385, 435, 801                                                                                                                                                                           |
| US-VA  | 276, 434, 540, 571, 686, 703, 757, 804, 826, 948                                                                                                                                        |
| US-VT  | 802                                                                                                                                                                                     |
| US-WA  | 206, 253, 360, 425, 509, 564                                                                                                                                                            |
| US-WI  | 262, 274, 353, 414, 534, 608, 715, 920                                                                                                                                                  |
| US-WV  | 304, 681                                                                                                                                                                                |
| US-WY  | 307                                                                                                                                                                                     |

Every entry above also yields the broader `US`.

### Canada

| Region | Area codes                                                                                    |
| ------ | --------------------------------------------------------------------------------------------- |
| CA-AB  | 368, 403, 587, 780, 825                                                                       |
| CA-BC  | 236, 250, 257, 604, 672, 778                                                                  |
| CA-MB  | 204, 431, 584                                                                                 |
| CA-NB  | 428, 506                                                                                      |
| CA-NL  | 709, 879                                                                                      |
| CA-ON  | 226, 249, 289, 343, 365, 382, 416, 437, 519, 548, 613, 647, 683, 705, 742, 753, 807, 905, 942 |
| CA-QC  | 263, 354, 367, 418, 438, 450, 468, 514, 579, 581, 819, 873                                    |
| CA-SK  | 306, 474, 639                                                                                 |

Every entry above also yields the broader `CA`. Three area codes are shared by more than one
province or territory and therefore resolve to `CA` alone rather than to a guessed subdivision:
**902** and **782** (Nova Scotia and Prince Edward Island) and **867** (Yukon, Northwest Territories
and Nunavut).

### Other NANP members

| Region                              | Area codes    |
| ----------------------------------- | ------------- |
| AG Antigua and Barbuda              | 268           |
| AI Anguilla                         | 264           |
| AS American Samoa                   | 684           |
| BB Barbados                         | 246           |
| BM Bermuda                          | 441           |
| BS Bahamas                          | 242           |
| DM Dominica                         | 767           |
| DO Dominican Republic               | 809, 829, 849 |
| GD Grenada                          | 473           |
| GU Guam                             | 671           |
| JM Jamaica                          | 658, 876      |
| KN Saint Kitts and Nevis            | 869           |
| KY Cayman Islands                   | 345           |
| LC Saint Lucia                      | 758           |
| MP Northern Mariana Islands         | 670           |
| MS Montserrat                       | 664           |
| PR Puerto Rico                      | 787, 939      |
| SX Sint Maarten                     | 721           |
| TC Turks and Caicos                 | 649           |
| TT Trinidad and Tobago              | 868           |
| VC Saint Vincent and the Grenadines | 784           |
| VG British Virgin Islands           | 284           |
| VI US Virgin Islands                | 340           |

### Non-geographic NANP codes

Toll-free (800, 833, 844, 855, 866, 877, 888), premium rate (900), personal communications
(500, 521–589 as assigned), and the carrier-internal codes (600, 622, 700, 710) resolve to **no
region at all**. A toll-free number is reachable from anywhere and says nothing about where its
holder or its caller is, so treating `+1 800…` as a US jurisdiction would assert a fact the number
does not carry.

### Country calling codes

All EU and EEA states, the UK, and the major world calling codes are compiled in. EU member states
additionally yield `EU`.

| Region                   | Calling code                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EU member states         | AT 43, BE 32, BG 359, CY 357, CZ 420, DE 49, DK 45, EE 372, ES 34, FI 358, FR 33, GR 30, HR 385, HU 36, IE 353, IT 39, LT 370, LU 352, LV 371, MT 356, NL 31, PL 48, PT 351, RO 40, SE 46, SI 386, SK 421                                                                                                                                                                                                                                                            |
| Rest of Europe           | AD 376, AL 355, AM 374, BA 387, BY 375, CH 41, FO 298, GB 44, GE 995, GI 350, IS 354, LI 423, MC 377, MD 373, ME 382, MK 389, NO 47, RS 381, RU 7, SM 378, UA 380, VA 379, XK 383                                                                                                                                                                                                                                                                                    |
| Africa                   | AO 244, BF 226, BI 257, BJ 229, BW 267, CD 243, CF 236, CG 242, CI 225, CM 237, CV 238, DJ 253, DZ 213, EG 20, ER 291, ET 251, GA 241, GH 233, GM 220, GN 224, GQ 240, GW 245, IO 246, KE 254, KM 269, LR 231, LS 266, LY 218, MA 212, MG 261, ML 223, MR 222, MU 230, MW 265, MZ 258, NA 264, NE 227, NG 234, RE 262, RW 250, SC 248, SD 249, SH 290, SL 232, SN 221, SO 252, SS 211, ST 239, SZ 268, TD 235, TG 228, TN 216, TZ 255, UG 256, ZA 27, ZM 260, ZW 263 |
| Americas                 | AR 54, AW 297, BO 591, BR 55, BZ 501, CL 56, CO 57, CR 506, CU 53, CW 599, EC 593, FK 500, GF 594, GL 299, GP 590, GT 502, GY 592, HN 504, HT 509, MQ 596, MX 52, NI 505, PA 507, PE 51, PM 508, PY 595, SR 597, SV 503, UY 598, VE 58                                                                                                                                                                                                                               |
| Asia and the Middle East | AE 971, AF 93, AZ 994, BD 880, BH 973, BN 673, BT 975, CN 86, HK 852, ID 62, IL 972, IN 91, IQ 964, IR 98, JO 962, JP 81, KG 996, KH 855, KP 850, KR 82, KW 965, LA 856, LB 961, LK 94, MM 95, MN 976, MO 853, MV 960, MY 60, NP 977, OM 968, PH 63, PK 92, PS 970, QA 974, SA 966, SG 65, SY 963, TH 66, TJ 992, TL 670, TM 993, TR 90, TW 886, UZ 998, VN 84, YE 967                                                                                               |
| Oceania                  | AU 61, CK 682, FJ 679, FM 691, KI 686, MH 692, NC 687, NF 672, NR 674, NU 683, NZ 64, PF 689, PG 675, PW 680, SB 677, TK 690, TO 676, TV 688, VU 678, WF 681, WS 685                                                                                                                                                                                                                                                                                                 |

Three codes are shared and resolve to the largest occupant, because a consistent answer is auditable
and an absent one is not: **7** resolves to `RU` (also Kazakhstan), **212** to `MA` (also Western
Sahara) and **599** to `CW` (formerly the wider Netherlands Antilles).

## How the overrides interact

Consent policy and prompt can be set at three levels. Resolution is strictly most-specific-wins, and
`null` at any level means "inherit", not "off":

1. **Inbound route** — `recordingConsentPolicy`, `recordingConsentPromptId` on the matched route.
2. **DID / phone number** — the same two fields on the number the call arrived on or dialled out from.
3. **Organization** — `recordings.consentPolicy` and `recordings.consentPromptId`.

The first level that names a policy wins outright; the others are not merged into it. A DID that sets
`announce-and-require-keypress` keeps it under an organization default of `none`, and a DID that sets
nothing follows the organization.

The remaining settings — accept and decline digits, the all-party region list, and DTMF auto-pause —
are **organization-wide only**. There is no per-DID region list: the regions are a property of the
tenant's compliance posture, not of one number.

The jurisdiction upgrade is applied **after** the override is resolved, so it lifts whichever policy
won. A per-DID `none` on a call touching `US-CA` still announces.

DTMF auto-pause resolves separately, in this order: an explicit value on the recording start request,
then the destination extension's `recordAutoPauseOnDtmf`, then the queue's, then the organization
default, then off. When it is on, a digit pressed during a recording pauses it and arms a quiet-window
timer (3 seconds, refreshed by each further digit) that resumes it — so a card number read aloud into
a keypad is not captured.

## What is recorded about consent

Every call that reaches the consent gate carries a consent record, including calls that declined and
calls where no consent was required. The record holds:

- `outcome` — `not-required`, `announced`, `accepted` or `declined`.
- `method` — `none`, `announcement` or `keypress`.
- `policy` — the policy that was actually in force after overrides and the jurisdiction upgrade.
- `at` — an ISO 8601 timestamp, stamped when the outcome was decided.
- `parties` — the sides the announcement was played at (`caller`, `callee`, or both): the sides
  whose media plane accepted the prompt, not the sides known to have heard it. A party whose leg was
  not carrying media in time is absent. See "What `announced` means, exactly" above.
- `regions` — the configured all-party regions this call matched, in the order they were configured.
  Empty when the announcement was the tenant's own choice rather than a jurisdiction upgrade.
- `promptId` — the prompt that was played, when one was.

It travels on the `channel.record.started` event as `consent`, is persisted alongside the recording
row, and is written onto the CDR leg for **every** outcome — including `declined`, where no recording
exists. The recordings list shows the outcome per row.

A declined call therefore leaves evidence that consent was sought and refused, which is the record
you want when someone later asks why a call was not recorded.

## Erasure

A party's recorded data can be erased by phone number or extension through
`POST /api/v1/erasure` (with `POST /api/v1/erasure/preview` for a no-op count first). It requires the
`recordings.delete` permission, deletes recording and voicemail objects before their rows, hashes the
CDR numbers and nulls the remaining PII columns, and keeps the CDR legs so billing counts survive. It
is idempotent and audited as `recording.erasure`.
