import { AclExtended } from "./acls.types";
import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { CredentialsExtended } from "./credentials.types";
import { Flatten, RenameAndConvertToTimestamp } from "./utils";

enum Transport {
	UDP = "UDP",
	TCP = "TCP",
	TLS = "TLS",
	SCTP = "SCTP",
	WS = "WS",
	WSS = "WSS",
}

type TrunkURI = {
	host: string;
	port: number;
	transport: Transport;
	user?: string;
	weight: number;
	priority: number;
	enabled: boolean;
};

type Trunk = {
	ref: string;
	name: string;
	sendRegister: boolean;
	inboundUri?: string;
	accessControlListRef?: string;
	inboundCredentialsRef?: string;
	outboundCredentialsRef?: string;
	uris?: TrunkURI[];
	createdAt: Date;
	updatedAt: Date;
};

type TrunkExtended = RenameAndConvertToTimestamp<Trunk> & {
	accessControlList?: AclExtended;
	inboundCredentials?: CredentialsExtended;
	outboundCredentials?: CredentialsExtended;
	extended?: Record<string, unknown>;
};

type CreateTrunkRequest = {
	name: string;
	sendRegister: boolean;
	inboundUri: string;
	accessControlListRef?: string;
	inboundCredentialsRef?: string;
	outboundCredentialsRef?: string;
	uris?: TrunkURI[];
};

type CreateTrunkRequestExtended = CreateTrunkRequest & {
	extended?: Record<string, unknown>;
};

type UpdateTrunkRequest = Flatten<BaseApiObject & Partial<CreateTrunkRequest>>;

type ListTrunksRequest = ListRequest;

type ListTrunksResponse = ListResponse<Trunk>;

type ListTrunksResponseExtended = ListResponse<TrunkExtended>;

type TrunkApi = {
	createTrunk(request: CreateTrunkRequest): Promise<BaseApiObject>;
	updateTrunk(request: UpdateTrunkRequest): Promise<BaseApiObject>;
	getTrunk(ref: string): Promise<TrunkExtended>;
	deleteTrunk(ref: string): Promise<void>;
	listTrunks(request: ListTrunksRequest): Promise<ListTrunksResponseExtended>;
};

export {
	CreateTrunkRequest,
	CreateTrunkRequestExtended,
	ListTrunksRequest,
	ListTrunksResponse,
	Transport,
	Trunk,
	TrunkApi,
	TrunkExtended,
	UpdateTrunkRequest,
};
