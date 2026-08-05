import SDK from "@routr/sdk";
import { NumberPreconditionsCheck } from "@optimiq-voice/common";
import { ClientOptions } from "../types";
import { createNumber } from "./createNumber";
import { getNumber } from "./getNumber";
import { listNumbers } from "./listNumbers";
import { deleteNumber } from "./operations";
import { updateNumber } from "./updateNumber";

function buildService(
  clientOptions: ClientOptions,
  checkNumberPreconditions: NumberPreconditionsCheck
) {
  const client = new SDK.Numbers(clientOptions);

  return {
    definition: {
      serviceName: "Numbers",
      pckg: "numbers",
      version: "v1beta2",
      proto: "numbers.proto"
    },
    handlers: {
      createNumber: createNumber(client, checkNumberPreconditions),
      updateNumber: updateNumber(client, checkNumberPreconditions),
      getNumber: getNumber(client),
      listNumbers: listNumbers(client),
      deleteNumber: deleteNumber(client)
    }
  };
}

export { buildService };
