import { Metadata } from "grpc-web";

type MappingTuple<T> = Array<[string, T]>;

type ClientFunction<T, U> = (
  request: T,
  metadata: Metadata | unknown | null,
  callback: (err: Error | null, response: U | null) => void
) => void;

type DataResponse = { toObject: () => unknown };

type ServerStream<U> = {
  on: (
    event: "data" | "error" | "end" | "status",
    listener: (response: U | Error | DataResponse) => void
  ) => void;
};

type ServerStreamFunction<T, U> = (
  request: T,
  metadata: Metadata | unknown | null
) => ServerStream<U>;

export { ClientFunction, DataResponse, MappingTuple, ServerStreamFunction };
