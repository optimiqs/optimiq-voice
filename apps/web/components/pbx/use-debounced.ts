"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Delays the value the QUERY uses, never the value the input shows.
 *
 * Debouncing the input itself would make typing feel laggy; debouncing only what reaches the
 * network keeps the field instant and still costs one request per pause.
 *
 * Shared by the list toolbar (`resource-list.tsx`) and the reference pickers
 * (`resource-select.tsx`), which want exactly the same 250ms behaviour against the same
 * `?search=` parameter.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer.current);
	}, [value, delayMs]);

	return settled;
}
