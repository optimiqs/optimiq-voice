import { jsonToObject } from "./jsonToObject";
import { objectToJson } from "./objectToJson";
import { ClientFunction, MappingTuple } from "./types";

function makeRpcRequest<
  RequestPB,
  ResponsePB,
  Request extends Record<string, unknown>,
  Response extends Record<string, unknown>
>(params: {
  method: ClientFunction<RequestPB, ResponsePB>;
  requestPBObjectConstructor: new () => RequestPB;
  metadata: unknown;
  request: Request;
  enumMapping?: MappingTuple<unknown>;
  objectMapping?: MappingTuple<unknown>;
  repeatableObjectMapping?: MappingTuple<unknown>;
}): Promise<Response> {
  const {
    method,
    requestPBObjectConstructor: RequestPBObjectConstructor,
    metadata,
    request,
    enumMapping,
    objectMapping,
    repeatableObjectMapping
  } = params;

  const reqPB = jsonToObject<Request, RequestPB>({
    json: request,
    objectConstructor: RequestPBObjectConstructor,
    enumMapping,
    objectMapping
  });

  return new Promise((resolve, reject) => {
    method(reqPB, metadata, (err: Error | null, responsePB: ResponsePB) => {
      if (err) {
        reject(err);
        return;
      }

      const json = objectToJson<Response>(
        responsePB as unknown as new () => unknown,
        enumMapping,
        objectMapping,
        repeatableObjectMapping
      );

      resolve(json);
    });
  });
}

export { makeRpcRequest };
