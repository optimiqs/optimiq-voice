import {
	ForbiddenException,
	NotFoundException,
	UnprocessableEntityException,
} from "@nestjs/common";

/**
 * Raised when the acting session holds `reseller.*` but its own organization is not flagged as a
 * reseller. The permission is only half the gate; the platform `is_reseller` flag is the other
 * half, and this is the failure when the flag is missing.
 */
export class NotAResellerException extends ForbiddenException {
	constructor() {
		super("This organization is not a reseller. The reseller surface is unavailable.");
	}
}

/**
 * Raised when a reseller reaches for a child organization it does not administer — the row check
 * that keeps `parent_organization_id = this reseller` true for every write.
 */
export class NotYourChildException extends NotFoundException {
	constructor() {
		super("No such child organization under this reseller.");
	}
}

/**
 * Raised when a create names an `ownerUserId` that is not a real user.
 *
 * 422 rather than 404: the request is well-formed but names a resource that must exist for the
 * seating to be possible, and reporting it before the insert turns a foreign-key violation (a 500
 * the caller cannot act on) into a field-level answer they can.
 */
export class UnknownOwnerException extends UnprocessableEntityException {
	constructor(userId: string) {
		super({
			statusCode: 422,
			code: "RESELLER_UNKNOWN_OWNER",
			message: `No user with id ${userId} to seat as the child's owner.`,
		});
	}
}
