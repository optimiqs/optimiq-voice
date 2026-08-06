import { Module } from "@nestjs/common";
import { IdentityInviteController } from "./http/identity-invite.controller";
import { RuntimeHostService } from "./runtime/runtime-host.service";

/**
 * `GET /api/recordings/:id` used to be mounted here and is gone.
 *
 * It was an anonymous read of any file under the recording root whose name a caller could guess —
 * `resolve()` stopped path traversal, nothing stopped enumeration — and its own comment said so,
 * recording "a signed, expiring URL minted alongside the recording" as the fix. That fix landed:
 * `src/cdr/recordings` mints `POST /api/v1/recordings/:id/download-url` under
 * `recordings.download` and serves the bytes from `GET /api/v1/recordings/media?token=…`, where
 * the recording id lives inside the signed blob and the read still runs through the tenant's RLS
 * policy. `apps/web` has only ever used that path.
 *
 * The route's one remaining caller was `apps/autopilot`, which posts
 * `${AUTOPILOT_RECORDING_BASE_URL}/<appRef>_<mediaSessionRef>.wav` into a customer's `eventsHook`.
 * Keeping it behind a session guard instead would not have helped anyone: a webhook fetcher has no
 * session by definition, so authenticating the route breaks that caller exactly as removing it
 * does — and those file names are ARI recording artifacts, not `cdr-db` `recordings` rows, so
 * there is no owning organization to scope such a request to in the first place. Autopilot's
 * migration is to mint a signed link, and it is a change on autopilot's side.
 */
@Module({
	controllers: [IdentityInviteController],
	providers: [RuntimeHostService],
})
export class AppModule {}
