import Fastify, { FastifyInstance } from "fastify";
import { getLogger } from "@optimiq-voice/logger";
import { IdentityConfig } from "../exchanges/types";
import { createUpdateMembershipStatus } from "../utils";

const logger = getLogger({ service: "identity", filePath: __filename });

/**
 * Minimal HTTP bridge for the standalone Identity service. It serves only the
 * accept-invite endpoint (the api's bridge also serves telephony routes).
 */
async function startHttpBridge(
  identityConfig: IdentityConfig,
  params: { port: number; appUrl: string }
): Promise<FastifyInstance> {
  const { port, appUrl } = params;
  const app = Fastify();

  app.get<{ Querystring: { token?: string | string[] } }>(
    "/api/identity/accept-invite",
    async (request, reply) => {
      try {
        const token = Array.isArray(request.query.token)
          ? request.query.token[0]
          : request.query.token;
        if (!token) {
          throw new Error("missing invite token");
        }

        await createUpdateMembershipStatus(identityConfig)(token);
        return reply.redirect(appUrl);
      } catch (error) {
        logger.verbose("error updating membership status", error);
        return reply.redirect(identityConfig.workspaceInviteFailUrl);
      }
    }
  );

  await app.listen({ port, host: "0.0.0.0" });
  logger.info(`Identity HTTP bridge running on port ${port}`);

  return app;
}

export { startHttpBridge };
