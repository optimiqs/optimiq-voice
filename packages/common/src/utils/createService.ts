import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

type ServiceDefinitionParams = {
  serviceName: string;
  pckg: string;
  proto: string;
  version: string;
};

const loadOptions = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: false,
  arrays: true,
  oneofs: true
};

function createServiceDefinition(
  params: ServiceDefinitionParams
): grpc.ServiceDefinition<grpc.UntypedServiceImplementation> {
  const pathToProto = `${__dirname}/../protos/${params.proto}`;
  const definitions = protoLoader.loadSync(pathToProto, loadOptions);

  return grpc.loadPackageDefinition(definitions).optimiq_voice[params.pckg][
    params.version
  ][params.serviceName].service;
}

export { ServiceDefinitionParams, createServiceDefinition };
