import {
	CreateDomainRequest,
	CreateDomainResponse,
	DeleteDomainRequest,
	DeleteDomainResponse,
	Domain,
	GetDomainRequest,
	ListDomainsRequest,
	ListDomainsResponse,
	UpdateDomainRequest,
	UpdateDomainResponse,
} from "../../generated/web/domains_pb";
import { ClientFunction } from "./common";

type DomainsClient = {
	createDomain: ClientFunction<CreateDomainRequest, CreateDomainResponse>;
	getDomain: ClientFunction<GetDomainRequest, Domain>;
	updateDomain: ClientFunction<UpdateDomainRequest, UpdateDomainResponse>;
	listDomains: ClientFunction<ListDomainsRequest, ListDomainsResponse>;
	deleteDomain: ClientFunction<DeleteDomainRequest, DeleteDomainResponse>;
};

export { DomainsClient };
