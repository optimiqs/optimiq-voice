import { Validators as V, withErrorHandlingAndValidation } from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";
import { withTenantResourceAccess } from "./withTenantResourceAccess";

const logger = getLogger({ service: "sipnet", filePath: __filename });

function deleteResource<T, R, U>(api: U, resource: string) {
	const fn = async (call: { request: R }): Promise<T> => {
		const { request } = call as { request: { ref: string } };

		logger.verbose(`call to delete${resource}`, { request, resource });

		await api[`delete${resource}`](request.ref);

		return { ref: request.ref } as T;
	};

	return withErrorHandlingAndValidation(
		withTenantResourceAccess(fn, (ref: string) => api[`get${resource}`](ref), resource),
		V.emptySchema,
	);
}

export { deleteResource };
