import { APP_REF_HEADER } from "@optimiq-voice/common";
import { INumber, INumberExtended } from "@optimiq-voice/types";

function convertToOptimiqVoiceNumber(number: INumberExtended): INumber {
  const appRef = number.extraHeaders?.find(
    (header) => header.name === APP_REF_HEADER
  )?.value;

  return {
    ref: number.ref,
    name: number.name,
    telUrl: number.telUrl,
    appRef,
    agentAor: appRef ? undefined : number.aorLink,
    city: number.city,
    country: number.country,
    countryIsoCode: number.countryIsoCode,
    trunk: number.trunk,
    createdAt: new Date(number.createdAt * 1000),
    updatedAt: new Date(number.updatedAt * 1000)
  };
}

export { convertToOptimiqVoiceNumber };
