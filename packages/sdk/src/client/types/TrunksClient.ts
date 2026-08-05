import {
  CreateTrunkRequest,
  CreateTrunkResponse,
  DeleteTrunkRequest,
  DeleteTrunkResponse,
  GetTrunkRequest,
  ListTrunksRequest,
  ListTrunksResponse,
  Trunk,
  UpdateTrunkRequest,
  UpdateTrunkResponse
} from "../../generated/web/trunks_pb";
import { ClientFunction } from "./common";

type TrunksClient = {
  createTrunk: ClientFunction<CreateTrunkRequest, CreateTrunkResponse>;
  getTrunk: ClientFunction<GetTrunkRequest, Trunk>;
  updateTrunk: ClientFunction<UpdateTrunkRequest, UpdateTrunkResponse>;
  listTrunks: ClientFunction<ListTrunksRequest, ListTrunksResponse>;
  deleteTrunk: ClientFunction<DeleteTrunkRequest, DeleteTrunkResponse>;
};

export { TrunksClient };
