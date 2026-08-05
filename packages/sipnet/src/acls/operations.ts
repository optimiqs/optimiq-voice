import {
  AclExtended,
  AclsApi,
  BaseApiObject,
  ListAclsRequest
} from "@optimiq-voice/types";
import { deleteResource } from "../resources/deleteResource";
import { getResource } from "../resources/getResource";
import { listResources } from "../resources/listResources";

const RESOURCE = "Acl";

function getAcl(acls: AclsApi) {
  return getResource<AclExtended, BaseApiObject, AclsApi>(acls, RESOURCE);
}

function listAcls(acls: AclsApi) {
  return listResources<AclExtended, ListAclsRequest, AclsApi>(acls, RESOURCE);
}

function deleteAcl(acls: AclsApi) {
  return deleteResource<AclExtended, BaseApiObject, AclsApi>(acls, RESOURCE);
}

export { deleteAcl, getAcl, listAcls };
