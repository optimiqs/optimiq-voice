import {
	CreateNumberRequest,
	CreateNumberResponse,
	DeleteNumberRequest,
	DeleteNumberResponse,
	GetNumberRequest,
	Number as INumber,
	ListNumbersRequest,
	ListNumbersResponse,
	UpdateNumberRequest,
	UpdateNumberResponse,
} from "../../generated/web/numbers_pb";
import { ClientFunction } from "./common";

type NumbersClient = {
	createNumber: ClientFunction<CreateNumberRequest, CreateNumberResponse>;
	getNumber: ClientFunction<GetNumberRequest, INumber>;
	updateNumber: ClientFunction<UpdateNumberRequest, UpdateNumberResponse>;
	listNumbers: ClientFunction<ListNumbersRequest, ListNumbersResponse>;
	deleteNumber: ClientFunction<DeleteNumberRequest, DeleteNumberResponse>;
};

export { NumbersClient };
