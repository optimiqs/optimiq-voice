import * as fs from "fs";
import * as grpc from "@grpc/grpc-js";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "common", filePath: __filename });

type CredentialsConfig = {
  tlsOn?: boolean;
  verifyClientCert?: boolean;
  caCert?: string;
  serverCert?: string;
  serverKey?: string;
};

async function getServerCredentials(config: CredentialsConfig) {
  const { tlsOn, verifyClientCert, caCert, serverCert, serverKey } = config;

  logger.verbose("get server credentials", {
    tlsOn,
    verifyClientCert,
    caCert,
    serverCert,
    serverKey
  });

  if (tlsOn) {
    const cacert = verifyClientCert ? fs.readFileSync(caCert) : null;

    return grpc.ServerCredentials.createSsl(cacert, [
      {
        private_key: await fs.promises.readFile(serverKey),
        cert_chain: await fs.promises.readFile(serverCert)
      }
    ]);
  }

  return grpc.ServerCredentials.createInsecure();
}

export { CredentialsConfig, getServerCredentials };
