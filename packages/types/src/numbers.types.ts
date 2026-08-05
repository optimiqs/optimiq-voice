import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { TrunkExtended } from "./trunks.types";
import { Flatten, RenameAndConvertToTimestamp } from "./utils";

type INumber = {
  ref: string;
  name: string;
  telUrl: string;
  appRef?: string;
  agentAor?: string;
  city: string;
  country: string;
  countryIsoCode: string;
  trunk?: {
    ref: string;
    name: string;
  };
  createdAt: Date;
  updatedAt: Date;
};

type CreateNumberRequest = {
  name: string;
  telUrl: string;
  city: string;
  country: string;
  countryIsoCode: string;
  trunkRef?: string;
  appRef?: string;
  agentAor?: string;
};

type UpdateNumberRequest = Flatten<
  BaseApiObject &
    Omit<
      Partial<CreateNumberRequest>,
      "telUrl" | "city" | "country" | "countryIsoCode"
    >
>;

type INumberExtended = RenameAndConvertToTimestamp<
  Omit<INumber, "appRef" | "agentAor" | "trunk">
> & {
  aorLink?: string;
  trunk?: TrunkExtended;
  extended?: Record<string, unknown>;
  extraHeaders?: { name: string; value: string }[];
};

type CreateNumberRequestExtended = CreateNumberRequest & {
  trunkRef?: string;
  extended?: Record<string, unknown>;
  extraHeaders?: { name: string; value: string }[];
};

type ListNumbersRequest = ListRequest;

type ListNumbersResponse = ListResponse<INumber>;

type ListNumbersResponseExtended = ListResponse<INumberExtended>;

type NumbersApi = {
  createNumber(request: CreateNumberRequestExtended): Promise<BaseApiObject>;
  updateNumber(request: UpdateNumberRequest): Promise<BaseApiObject>;
  getNumber(ref: string): Promise<INumberExtended>;
  deleteNumber(ref: string): Promise<void>;
  listNumbers(
    request: ListNumbersRequest
  ): Promise<ListNumbersResponseExtended>;
};

export {
  CreateNumberRequest,
  CreateNumberRequestExtended,
  INumber,
  INumberExtended,
  ListNumbersRequest,
  ListNumbersResponse,
  NumbersApi,
  UpdateNumberRequest
};
