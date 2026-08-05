import { Box, styled } from "@mui/material";
import { jwtDecode } from "jwt-decode";
import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { getRequiredSession } from "~/auth/services/sessions/session.server";
import { AuthenticatedProvider } from "~/auth/stores/authenticated.store";
import { useOptimiqVoice } from "~/core/sdk/hooks/use-optimiq-voice";
import { IS_CLOUD } from "~/core/sdk/stores/optimiq-voice.config";
import { Logger } from "~/core/shared/logger";
import { Header } from "../general/header/header";
import type { Route } from "./+types/authenticated.layout";
import type { IDTokenPayload } from "~/auth/services/sessions/auth.interfaces";

export const shouldRevalidate = () => false;

/**
 * Route loader function that ensures the user is authenticated before rendering the layout.
 * If not authenticated, this function will automatically redirect to the login page
 * via `getRequiredSession()`.
 *
 * @param request - The incoming HTTP request object from Remix
 * @returns The session object if authenticated
 */
export async function loader({ request }: Route.LoaderArgs) {
  return await getRequiredSession(request.headers.get("Cookie"));
}

/**
 * Authenticated Layout component
 *
 * This is the layout for authenticated users. It wraps protected routes
 * and will eventually include a header with user information and logout functionality.
 */
export default function AuthenticatedLayout({
  loaderData: { session }
}: Route.ComponentProps) {
  const { client } = useOptimiqVoice();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!IS_CLOUD) return;

    const idToken = client.getIdToken();
    if (!idToken) return;

    const { emailVerified, phoneNumberVerified } =
      jwtDecode<IDTokenPayload>(idToken);

    Logger.debug("[ID Token] Decoded", {
      emailVerified,
      phoneNumberVerified,
      currentPath: pathname
    });

    const isVerified = emailVerified && phoneNumberVerified;

    if (!isVerified && pathname !== "/accounts/verify") {
      Logger.debug("[Redirect] Not verified, redirecting to /accounts/verify");
      navigate("/accounts/verify", { replace: true });
    }

    if (isVerified && pathname === "/accounts/verify") {
      Logger.debug("[Redirect] Already verified, redirecting to home");
      navigate("/", { replace: true });
    }
  }, [client, pathname, navigate]);

  return (
    <AuthenticatedProvider initialSession={session}>
      <MainRoot>
        <Header />
        <MainContent>
          <Outlet />
        </MainContent>
      </MainRoot>
    </AuthenticatedProvider>
  );
}

export const MainRoot = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  flexGrow: 1,
  height: "100%",
  overflow: "hidden",
  backgroundColor: theme.palette.bg.app,
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.bg.app
  })
}));

export const MainContent = styled(Box)(({ theme }) => ({
  display: "flex",
  flexDirection: "column",
  height: "100%",
  backgroundColor: theme.palette.bg.app,
  overflow: "hidden",
  ...theme.applyStyles("dark", {
    backgroundColor: theme.palette.bg.app
  })
}));
