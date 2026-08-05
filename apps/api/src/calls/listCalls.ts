import { ServerInterceptingCall } from "@grpc/grpc-js";
import {
  getAccessKeyIdFromCall,
  GrpcErrorMessage,
  InfluxDBClient,
  Validators as V,
  withErrorHandlingAndValidation
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { ListCallsRequest, ListCallsResponse } from "@optimiq-voice/types";
import { createFetchCalls } from "./createFetchCalls";

const logger = getLogger({ service: "api", filePath: __filename });

function listCalls(influx: InfluxDBClient) {
  const fetchCalls = createFetchCalls(influx);

  const fn = async (
    call: {
      request: ListCallsRequest;
    },
    callback: (error?: GrpcErrorMessage, response?: ListCallsResponse) => void
  ) => {
    const { request } = call;

    const accessKeyId = getAccessKeyIdFromCall(
      call as unknown as ServerInterceptingCall
    );

    logger.verbose("call to listCalls", { request, accessKeyId });

    const result = await fetchCalls(accessKeyId, request);

    callback(null, result);
  };

  return withErrorHandlingAndValidation(fn, V.listCallsRequestSchema);
}

export { listCalls };
