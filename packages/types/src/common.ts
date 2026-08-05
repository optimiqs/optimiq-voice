enum ContactType {
	EMAIL = "EMAIL",
	PHONE = "PHONE",
}

type BaseApiObject = {
	ref: string;
};

type NumberPreconditionsCheck = (request: { appRef?: string; agentAor?: string }) => Promise<void>;

type ListRequest = {
	pageSize?: number;
	pageToken?: string;
};

type ListResponse<R> = {
	items: R[];
	nextPageToken?: string;
};

export { BaseApiObject, ContactType, ListRequest, ListResponse, NumberPreconditionsCheck };
