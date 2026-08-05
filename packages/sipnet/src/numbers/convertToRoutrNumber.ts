import { APP_REF_HEADER, ROUTR_DEFAULT_PEER_AOR } from "@optimiq-voice/common";
import { CreateNumberRequest, UpdateNumberRequest } from "@optimiq-voice/types";

function convertToRoutrNumber(
  number: CreateNumberRequest,
  accessKeyId: string
) {
  const aorLink = number.appRef ? ROUTR_DEFAULT_PEER_AOR : number.agentAor;

  return {
    name: number.name,
    telUrl: number.telUrl,
    aorLink,
    city: number.city,
    country: number.country,
    countryIsoCode: number.countryIsoCode,
    extraHeaders: number.appRef
      ? [
          {
            name: APP_REF_HEADER,
            value: number.appRef
          }
        ]
      : [],
    trunkRef: number.trunkRef,
    extended: { accessKeyId } as Record<string, unknown>
  };
}

function convertToRoutrNumberUpdate(number: UpdateNumberRequest) {
  let aorLink: string | undefined;
  let extraHeaders: { name: string; value: string }[] = [];

  if (number.appRef) {
    aorLink = ROUTR_DEFAULT_PEER_AOR;
    extraHeaders.push({
      name: APP_REF_HEADER,
      value: number.appRef
    });
  } else if (number.agentAor) {
    extraHeaders = null;
    aorLink = number.agentAor;
  }

  return {
    ref: number.ref,
    name: number.name,
    aorLink,
    extraHeaders,
    trunkRef: number.trunkRef
  };
}

export { convertToRoutrNumber, convertToRoutrNumberUpdate };
