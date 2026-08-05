import { z } from "zod";
import { fromError } from "zod-validation-error";

export function validateRequest<T>(schema: z.Schema<T>, data: unknown): T {
	const parsedData = schema.safeParse(data);

	if (!parsedData.success) {
		throw fromError(parsedData.error, {
			prefix: null,
		});
	}

	return parsedData.data;
}
