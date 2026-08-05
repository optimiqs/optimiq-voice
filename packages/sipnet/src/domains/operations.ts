import { Validators as V } from "@optimiq-voice/common";
import {
	BaseApiObject,
	CreateDomainRequestExtended,
	DomainExtended,
	DomainsApi,
	ListDomainsRequest,
	UpdateDomainRequest,
} from "@optimiq-voice/types";
import { createResource } from "../resources/createResource";
import { deleteResource } from "../resources/deleteResource";
import { getResource } from "../resources/getResource";
import { listResources } from "../resources/listResources";
import { updateResource } from "../resources/updateResource";

const RESOURCE = "Domain";

function createDomain(domains: DomainsApi) {
	return createResource<CreateDomainRequestExtended, BaseApiObject, DomainsApi>(
		domains,
		RESOURCE,
		V.createDomainRequestSchema,
	);
}

function updateDomain(domains: DomainsApi) {
	return updateResource<UpdateDomainRequest, BaseApiObject, DomainsApi>(
		domains,
		RESOURCE,
		V.updateDomainRequestSchema,
	);
}

function getDomain(domains: DomainsApi) {
	return getResource<DomainExtended, BaseApiObject, DomainsApi>(domains, RESOURCE);
}

function listDomains(domains: DomainsApi) {
	return listResources<DomainExtended, ListDomainsRequest, DomainsApi>(domains, RESOURCE);
}

function deleteDomain(domains: DomainsApi) {
	return deleteResource<DomainExtended, BaseApiObject, DomainsApi>(domains, RESOURCE);
}

export { createDomain, deleteDomain, getDomain, listDomains, updateDomain };
