import { z } from "zod";
import { Verb } from "./Verb";

class Hangup extends Verb {
	getValidationSchema(): z.Schema {
		return z.object({});
	}
}

export { Hangup };
