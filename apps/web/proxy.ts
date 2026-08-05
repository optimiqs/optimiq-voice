import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_PREFIX } from "~/lib/auth-constants";
import { isPublicRoute, routes, signInWithRedirect } from "~/lib/routes";

/**
 * An OPTIMISTIC redirect, and nothing more.
 *
 * This only checks that a session cookie is present — it does not verify it, and it must not be
 * mistaken for authorization. Verification costs a database round trip that better-auth explicitly
 * advises against putting in middleware, and it would be the wrong place anyway: the real gate is
 * `apps/api`'s `RequirePermissionsGuard`, with `app/(app)/layout.tsx` resolving the session for
 * the UI. What this buys is that a signed-out visitor never sees the app shell flash before the
 * client redirect fires.
 *
 * This is Next 16's `proxy.ts` — the `middleware.ts` convention it replaces is deprecated and
 * warns on every build. The named `proxy` export is the documented form, and the runtime is
 * always Node (proxy has no edge option), which is why `better-auth/cookies` can be imported here
 * at all.
 *
 * A forged cookie gets past this and lands on a shell whose every request 401s. That is the
 * intended failure mode.
 */
export function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	const hasSessionCookie = getSessionCookie(request, { cookiePrefix: SESSION_COOKIE_PREFIX });

	if (isPublicRoute(pathname)) {
		// Someone already signed in has no business on the sign-in page.
		if (hasSessionCookie && (pathname === routes.signIn || pathname === routes.signUp)) {
			return NextResponse.redirect(new URL(routes.overview, request.url));
		}
		return NextResponse.next();
	}

	if (!hasSessionCookie) {
		return NextResponse.redirect(new URL(signInWithRedirect(`${pathname}${search}`), request.url));
	}

	return NextResponse.next();
}

export const config = {
	/**
	 * `/api` is excluded: those paths are rewritten to `apps/api`, and redirecting an XHR to an
	 * HTML sign-in page turns a clean 401 into an unparseable response.
	 */
	matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp|ico)$).*)"],
};
