import { Validators as V } from "@optimiq-voice/common";
import {
  BaseApiObject,
  CreateTrunkRequestExtended,
  ListTrunksRequest,
  TrunkApi,
  TrunkExtended,
  UpdateTrunkRequest
} from "@optimiq-voice/types";
import { createResource } from "../resources/createResource";
import { deleteResource } from "../resources/deleteResource";
import { getResource } from "../resources/getResource";
import { listResources } from "../resources/listResources";
import { updateResource } from "../resources/updateResource";

const RESOURCE = "Trunk";

function createTrunk(trunks: TrunkApi) {
  return createResource<TrunkExtended, CreateTrunkRequestExtended, TrunkApi>(
    trunks,
    RESOURCE,
    V.createTrunkRequestSchema
  );
}

function updateTrunk(trunks: TrunkApi) {
  return updateResource<TrunkExtended, UpdateTrunkRequest, TrunkApi>(
    trunks,
    RESOURCE,
    V.updateTrunkRequestSchema
  );
}

function getTrunk(trunks: TrunkApi) {
  return getResource<TrunkExtended, BaseApiObject, TrunkApi>(trunks, RESOURCE);
}

function listTrunks(trunks: TrunkApi) {
  return listResources<TrunkExtended, ListTrunksRequest, TrunkApi>(
    trunks,
    RESOURCE
  );
}

function deleteTrunk(trunks: TrunkApi) {
  return deleteResource<TrunkExtended, BaseApiObject, TrunkApi>(
    trunks,
    RESOURCE
  );
}

export { createTrunk, deleteTrunk, getTrunk, listTrunks, updateTrunk };
