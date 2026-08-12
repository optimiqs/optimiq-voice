import { ForbiddenException, NotFoundException } from "@nestjs/common";

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
