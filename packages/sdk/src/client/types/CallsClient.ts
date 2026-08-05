import {
  CallDetailRecord,
  CreateCallRequest,
  CreateCallResponse,
  GetCallRequest,
  ListCallsRequest,
  ListCallsResponse,
  TrackCallRequest
} from "../../generated/web/calls_pb";
import { ClientFunction, ServerStreamFunction } from "./common";

type CallsClient = {
  createCall: ClientFunction<CreateCallRequest, CreateCallResponse>;
  getCall: ClientFunction<GetCallRequest, CallDetailRecord>;
  listCalls: ClientFunction<ListCallsRequest, ListCallsResponse>;
  trackCall: ServerStreamFunction<TrackCallRequest, CallDetailRecord>;
};

export { CallsClient };
