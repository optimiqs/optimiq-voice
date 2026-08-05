import { z } from "zod";
import { StopSayRequest } from "@optimiq-voice/common";
import { Verb } from "./Verb";

class StopSay extends Verb<StopSayRequest> {
	getValidationSchema(): z.Schema {
		return z.object({});
	}
}

export { StopSay };
