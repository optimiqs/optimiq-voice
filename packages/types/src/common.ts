enum ContactType {
	EMAIL = "EMAIL",
	PHONE = "PHONE",
}

type BaseApiObject = {
	ref: string;
};

/**
 * Validates that the application (or agent AOR) a number points at exists **within the caller's
 * tenant**. The `organizationId` argument arrived with identity-removal Step 3 item 2: the check
 * used to run unscoped, so a number could be pointed at another tenant's application ref.
 */
type NumberPreconditionsCheck = (
	request: { appRef?: string; agentAor?: string },
	organizationId: string,
) => Promise<void>;

type ListRequest = {
	pageSize?: number;
	pageToken?: string;
};

type ListResponse<R> = {
	items: R[];
	nextPageToken?: string;
};

export { BaseApiObject, ContactType, ListRequest, ListResponse, NumberPreconditionsCheck };
