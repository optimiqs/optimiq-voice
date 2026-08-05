import { DialStatus, GrpcErrorMessage } from "@optimiq-voice/common";
import { CallDetailRecord, CallStatus, CallType, CreateCallRequest } from "@optimiq-voice/types";

type ListCallsRequest = {
	after?: string;
	before?: string;
	type?: CallType;
	status?: CallStatus;
	from?: string;
	to?: string;
	pageSize?: number;
	pageToken?: string;
};

type ListCallsResponse = {
	nextPageToken: string;
	items: CallDetailRecord[];
};

type GetCallRequest = {
	ref: string;
};

type CallPublisher = {
	publishCall: (event: CreateCallRequest & { ref: string; accessKeyId: string }) => void;
};

type TrackCallResponse = {
	ref: string;
	status: DialStatus;
};

type CallStream = {
	write: (data: TrackCallResponse | GrpcErrorMessage) => void;
	end: () => void;
};

type TrackCallSubscriber = {
	events: {
		on: (event: string, cb: (data: TrackCallResponse | Error) => void) => void;
	};
};

export {
	CallPublisher,
	CallStream,
	CreateCallRequest,
	GetCallRequest,
	ListCallsRequest,
	ListCallsResponse,
	TrackCallResponse,
	TrackCallSubscriber,
};
