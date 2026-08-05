import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { Flatten, RenameAndConvertToTimestamp } from "./utils";

type Acl = {
	ref: string;
	name: string;
	allow: string[];
	createdAt: Date;
	updatedAt: Date;
};

type AclExtended = RenameAndConvertToTimestamp<Acl> & {
	extended?: Record<string, unknown>;
};

type CreateAclRequest = {
	name: string;
	allow: string[];
};

type CreateAclRequestExtended = CreateAclRequest & {
	deny: string[];
	extended?: Record<string, unknown>;
};

type UpdateAclRequest = Flatten<BaseApiObject & Partial<CreateAclRequest>> & {
	deny: string[];
};

type ListAclsRequest = ListRequest;

type ListAclsResponse = ListResponse<Acl>;

type ListAclsResponseExtended = ListResponse<AclExtended>;

type AclsApi = {
	createAcl(request: CreateAclRequestExtended): Promise<BaseApiObject>;
	updateAcl(request: UpdateAclRequest): Promise<BaseApiObject>;
	getAcl(ref: string): Promise<AclExtended>;
	deleteAcl(ref: string): Promise<void>;
	listAcls(request: ListAclsRequest): Promise<ListAclsResponseExtended>;
};

export {
	Acl,
	AclExtended,
	AclsApi,
	CreateAclRequest,
	CreateAclRequestExtended,
	ListAclsRequest,
	ListAclsResponse,
	UpdateAclRequest,
};
