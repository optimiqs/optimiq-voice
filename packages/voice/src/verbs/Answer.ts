import { z } from "zod";
import { Verb } from "./Verb";

class Answer extends Verb {
  getValidationSchema(): z.Schema {
    return z.object({});
  }
}

export { Answer };
