import * as Validator from "validator";
import { z } from "zod";
import { nameSchema } from "../common";

const IP_OR_CIDR_MESSAGE = "Must be a valid IP or CIDR range";
const AT_LEAST_ONE_MESSAGE = "At least one IP or CIDR range is required";

const ipOrCidr = z
  .string()
  .refine(
    (value) => Validator.isIP(value, 4) || Validator.isIPRange(value, 4),
    {
      message: IP_OR_CIDR_MESSAGE
    }
  );

const createAclRequestSchema = z.object({
  name: nameSchema,
  allow: z.array(ipOrCidr).nonempty({ message: AT_LEAST_ONE_MESSAGE })
});

const updateAclRequestSchema = z.object({
  name: nameSchema,
  allow: z
    .array(ipOrCidr)
    .nonempty({ message: AT_LEAST_ONE_MESSAGE })
    .optional()
});

export { createAclRequestSchema, updateAclRequestSchema };
