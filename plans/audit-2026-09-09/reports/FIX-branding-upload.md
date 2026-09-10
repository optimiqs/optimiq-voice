# FIX — branding logo upload (E2E-admin F-3; F-2 was its prerequisite)

## F-3 · P1 — the branding screen has no logo upload control → **FIXED**

The raw `logoObjectKey` text field and its "(Upload-to-key is a pending media seam.)" help text are
gone; the product flow is in their place.

Files (all inside the granted area):

- `apps/web/lib/branding/logo.ts` **(new)** — the pure helpers. `BRANDING_LOGO_MAX_UPLOAD_BYTES`
  (mirrors the API's 2 MiB), `BRANDING_LOGO_ACCEPT`, `validateLogoFile()` (format by extension OR
  declared type, empty file, size cap — a courtesy check, the server's magic-byte sniff still
  decides), and `brandingLogoPreviewSrc(brand, version)` which appends `?v=<objectKey>` to the
  hostless logo route and leaves an `https:`/`data:` logo untouched.
- `apps/web/lib/branding/logo.spec.ts` **(new)** — 14 bun tests over both helpers.
- `apps/web/lib/branding/client.ts` — `uploadBrandingLogo(file)` via the existing `apiUpload`
  helper; `BRANDING_LOGO_PATH` exported beside the other two paths.
- `apps/web/app/(app)/settings/branding/_components/logo-field.tsx` **(new)** — the control:
  file picker (`accept` png/jpeg/webp/svg), client-side validation before the bytes leave, "Upload
  logo" with `loading`/disabled state, a preview of the SERVED logo, "Remove logo" (PATCH
  `logoObjectKey: null`), inline error from the API (`pbxFieldErrors(e).file` for the 400
  `MEDIA_UPLOAD_REJECTED` `issues[]`, falling back to the message — which is what a 413 carries),
  success toasts, and `usePermission("branding.write")` on every control on top of the page's
  existing `RequirePermission` wrapper.
- `apps/web/app/(app)/settings/branding/page.tsx` — the `logoObjectKey` `TextField` replaced by
  `<BrandingLogoField brand={loaded ?? DEFAULT_BRANDING} />`. Everything else on the page is
  untouched.

Design notes worth reviewing:

- **The upload is its own write, not a form field.** `POST /branding/logo` stores the bytes AND
  points the row at the minted key in one request and returns the re-resolved branding, so making it
  wait on "Save branding" would mean parking a `File` in form state for nothing. Both mutations seed
  `queryKeys.branding(orgId)` with the resolved result and then invalidate — the same shape
  `useSaveBranding` uses — which is what makes the sidebar lockup update in the same tick.
  `logoObjectKey` stays in the form schema so the page's own save round-trips the key rather than
  clearing it (the page re-seeds the form from the updated query on every change).
- **Cache busting is load-bearing.** The session-resolved logo read answers `private, max-age=300`,
  so a replacement upload would show the old image for five minutes on an unchanged URL. The token
  is the object key itself: it changes exactly when the bytes change, so an unchanged logo still
  hits the cache.
- The preview is a `background-image` span, not an `<img>`, matching `sidebar.tsx` — oxlint's
  `next(no-img-element)` refuses the `<img>` and `jsx-a11y(prefer-tag-over-role)` refuses
  `role="img"` on the span, so the mark is `aria-hidden` with an `sr-only` sibling stating whether a
  logo is set.

## Cross-area needed (out of my granted paths)

`apps/web/app/(app)/_components/sidebar.tsx` `BrandFooter` renders `brandLogoSrc(brand)` with no
version token. First upload and removal are fine (the URL was 404/becomes 404), but REPLACING a logo
can leave the sidebar showing the previous mark for up to 5 minutes, from the browser cache, on the
same URL. One-line fix once that file is free: `brandingLogoPreviewSrc(brand, brand.logoObjectKey)`
from `~/lib/branding/logo` in place of `brandLogoSrc(brand)`. `(auth)/layout.tsx` has the same shape
for the pre-auth lockup (there the read is host-keyed and `public, max-age=300`).

## Verification

- `pnpm --filter @optimiq-voice/web run typecheck` — one pre-existing error, and it is not mine:
  `lib/softphone/jssip-adapter.spec.ts(214,24) TS2769` (the softphone agent's area). No error in any
  file I touched.
- `pnpm --filter @optimiq-voice/web run test` — **794 pass, 0 fail** (35 files, 2632 assertions);
  branding alone: 45 pass, 0 fail across 4 files.
- `pnpm exec oxlint apps/web` — clean (0 findings).
- `pnpm exec oxfmt apps/web` — clean, 342 files.

### Live stack (Playwright, `e2e/artifacts/admin/06-branding-logo.mjs`, new) — **16/16 passed**

Signed in through the UI as `admmtuci4bt-owner@admin.test`:

- file input present; "pending media seam" copy gone.
- a `.gif` is refused client-side with "Choose a PNG, JPEG, WebP or SVG image." before any request.
- PNG upload → `POST /api/v1/branding/logo` **200**; preview `background-image` is
  `/api/v1/branding/logo?v=branding%2F<org>%2F<id>.png`; `GET /api/v1/branding/logo` with the session
  → **200 image/png, private, max-age=300**; the sidebar lockup shows the same URL.
- "Remove logo" → `PATCH /api/v1/branding` **200**, preview falls back to "None", and a `no-store`
  re-read of the logo route is **404**. (A plain re-read answers 200 from the browser cache for five
  more minutes — the observation that motivates the version token, and the cross-area note above.)
- Non-admin (`admmtuci4bt-self@admin.test`): no file input at all, the read-only fallback is shown,
  and a hand-rolled multipart `POST /branding/logo` from that session is **403**.

Screenshots: `shots/20-branding-before.png`, `21-branding-uploaded.png`, `22-branding-removed.png`,
`23-branding-readonly.png`.

No services restarted (web is `next dev`); nothing committed or staged. Test data left behind: none —
the uploaded logo was removed by the scenario itself.
