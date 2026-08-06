import { z } from "zod/v4";

/**
 * Pagination and the list envelope — oikos §4, "never unbounded".
 *
 * The envelope shape is the contract `apps/web` (P4) builds its tables against, so it is stated
 * once here and every list endpoint returns exactly it:
 *
 * ```jsonc
 * { "data": [ … ], "total": 137, "page": 2, "limit": 20, "totalPages": 7 }
 * ```
 *
 * `total` comes from a `count(*) over ()` window on the same query rather than a second
 * `select count(*)`, so the count and the page can never disagree about the snapshot they were
 * taken from.
 */

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Query DTO every list endpoint accepts. Coerced, because query strings are strings. */
export const listQuerySchema = z.object({
	page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
	limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
	/** Free-text search over the resource's searchable columns. Trimmed; empty means "no filter". */
	search: z
		.string()
		.max(128)
		.optional()
		.transform((value) => value?.trim())
		.transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
	/** `true` / `false` narrow to that state; absent returns both. */
	enabled: z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] }).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface Pagination {
	readonly page: number;
	readonly limit: number;
	readonly offset: number;
}

export function normalizePagination(input: {
	readonly page?: number;
	readonly limit?: number;
}): Pagination {
	const page = Math.max(1, Math.trunc(input.page ?? DEFAULT_PAGE));
	const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)));
	return { page, limit, offset: (page - 1) * limit };
}

export interface PagedResult<T> {
	readonly data: readonly T[];
	readonly total: number;
	readonly page: number;
	readonly limit: number;
	readonly totalPages: number;
}

export function paged<T>(
	rows: readonly T[],
	total: number,
	pagination: Pagination,
): PagedResult<T> {
	return {
		data: rows,
		total,
		page: pagination.page,
		limit: pagination.limit,
		totalPages: total === 0 ? 0 : Math.ceil(total / pagination.limit),
	};
}
