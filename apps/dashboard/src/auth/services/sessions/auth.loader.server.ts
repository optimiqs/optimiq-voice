import { data } from "react-router";
import { refreshSession } from "~/core/helpers/token-validators";
import { getClient } from "~/core/sdk/client/optimiq-voice.server";
import {
  commitSession,
  destroySession,
  getSession,
  getSessionCookie
} from "./session.server";
import type { Route } from "../../../+types/root";

export const rootAuthLoader = async ({ request }: Route.LoaderArgs) => {
  const headers = request.headers.get("Cookie");
  const { session, ...rest } = await getSession(headers);
  const sessionCookie = await getSessionCookie(headers);

  try {
    if (session) {
      const client = getClient();
      const refreshToken = await refreshSession(session, client);

      sessionCookie.set("refreshToken", refreshToken);
    }
  } catch (error) {
    return data(
      { session: null, ...rest },
      { headers: { "Set-Cookie": await destroySession(sessionCookie) } }
    );
  }

  return data(
    { session, ...rest },
    { headers: { "Set-Cookie": await commitSession(sessionCookie) } }
  );
};
