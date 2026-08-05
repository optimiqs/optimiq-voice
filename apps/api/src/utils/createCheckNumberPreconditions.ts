import { status } from "@grpc/grpc-js";
import { GrpcError } from "@optimiq-voice/common";
import { NumberPreconditionsCheck } from "@optimiq-voice/common";
import { Database } from "../core/db";

function createCheckNumberPreconditions(db: Database): NumberPreconditionsCheck {
	return async function checkNumberPreconditions({ appRef }, organizationId) {
		// You can have a Number without an Application but it must exist
		if (!appRef) {
			return;
		}

		// Scoped: another tenant's application ref is invisible here, so pointing a number at it
		// fails the precondition instead of silently succeeding.
		const app = await db.forOrganization(organizationId).application.findUnique({
			where: { ref: appRef },
		});

		if (!app) {
			throw new GrpcError(status.INVALID_ARGUMENT, "Application not found for ref: " + appRef);
		}
	};
}

export { createCheckNumberPreconditions };
