import {
  BaseApiObject,
  INumberExtended,
  NumbersApi
} from "@optimiq-voice/types";
import { deleteResource } from "../resources/deleteResource";

const RESOURCE = "Number";

function deleteNumber(numbers: NumbersApi) {
  return deleteResource<INumberExtended, BaseApiObject, NumbersApi>(
    numbers,
    RESOURCE
  );
}

export { deleteNumber };
