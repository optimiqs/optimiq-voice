import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { Flatten, RenameAndConvertToTimestamp } from "./utils";

type Domain = {
  ref: string;
  name: string;
  domainUri: string;
  accessControlList?: {
    ref: string;
    name: string;
    allow: string[];
    deny: string[];
  };
  egressPolicies?: { rule: string; numberRef: string }[];
  createdAt: Date;
  updatedAt: Date;
};

type DomainExtended = RenameAndConvertToTimestamp<Domain> & {
  extended?: Record<string, unknown>;
};

type CreateDomainRequest = {
  name: string;
  domainUri: string;
  accessControlListRef?: string;
  egressPolicies?: { rule: string; numberRef: string }[];
};

type CreateDomainRequestExtended = CreateDomainRequest & {
  extended?: Record<string, unknown>;
};

type UpdateDomainRequest = Flatten<
  BaseApiObject & Omit<Partial<CreateDomainRequest>, "domainUri">
>;

type ListDomainsRequest = ListRequest;

type ListDomainsResponse = ListResponse<Domain>;

type ListDomainsResponseExtended = ListResponse<DomainExtended>;

type DomainsApi = {
  createDomain: (request: CreateDomainRequest) => Promise<BaseApiObject>;
  updateDomain: (request: UpdateDomainRequest) => Promise<BaseApiObject>;
  getDomain: (ref: string) => Promise<DomainExtended>;
  listDomains: (
    request: ListDomainsRequest
  ) => Promise<ListDomainsResponseExtended>;
  deleteDomain: (ref: string) => Promise<void>;
};

export {
  CreateDomainRequest,
  CreateDomainRequestExtended,
  Domain,
  DomainExtended,
  DomainsApi,
  ListDomainsRequest,
  ListDomainsResponse,
  UpdateDomainRequest
};
