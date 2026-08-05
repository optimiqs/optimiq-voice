import { Database } from "../core/db";
import { createSecret } from "./createSecret";
import { deleteSecret } from "./deleteSecret";
import { getSecret } from "./getSecret";
import { listSecrets } from "./listSecrets";
import { updateSecret } from "./updateSecret";

function buildService(db: Database) {
  return {
    definition: {
      serviceName: "Secrets",
      pckg: "secrets",
      version: "v1beta2",
      proto: "secrets.proto"
    },
    handlers: {
      createSecret: createSecret(db),
      getSecret: getSecret(db),
      listSecrets: listSecrets(db),
      deleteSecret: deleteSecret(db),
      updateSecret: updateSecret(db)
    }
  };
}

export { buildService };
