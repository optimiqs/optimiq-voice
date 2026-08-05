import {
	Acl,
	CreateAclRequest,
	CreateAclResponse,
	DeleteAclRequest,
	DeleteAclResponse,
	GetAclRequest,
	ListAclsRequest,
	ListAclsResponse,
	UpdateAclRequest,
	UpdateAclResponse,
} from "../../generated/web/acls_pb";
import { ClientFunction } from "./common";

type AclsClient = {
	createAcl: ClientFunction<CreateAclRequest, CreateAclResponse>;
	getAcl: ClientFunction<GetAclRequest, Acl>;
	updateAcl: ClientFunction<UpdateAclRequest, UpdateAclResponse>;
	listAcls: ClientFunction<ListAclsRequest, ListAclsResponse>;
	deleteAcl: ClientFunction<DeleteAclRequest, DeleteAclResponse>;
};

export { AclsClient };
