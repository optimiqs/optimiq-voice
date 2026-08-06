"use client";

import { useCallback, useState } from "react";
import { pbxFieldErrors } from "../pbx/errors";

/**
 * Server-produced field messages, held for as long as they are true.
 *
 * The client schema catches what it can before a round trip; the server catches what only it can
 * know — that extension 1001 already exists, that a destination points at a row that was deleted
 * a moment ago, that the compiler would reject the result. Those messages belong on the same
 * controls the client's own messages use, which is what `submitError` on the field adapters is
 * for.
 *
 * They are cleared when a submit STARTS, not when a field changes. A message like "1001 already
 * exists" stays true while the user edits the caller-id name next to it, and clearing it on the
 * first keystroke anywhere would hide the only explanation for why the save failed. The next
 * submit is the moment the claim is re-tested, so that is the moment it is withdrawn.
 */
export function useServerFieldErrors(): {
	readonly errors: Readonly<Record<string, string>>;
	readonly clear: () => void;
	readonly capture: (error: unknown) => void;
} {
	const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

	const clear = useCallback(() => setErrors({}), []);
	const capture = useCallback((error: unknown) => setErrors(pbxFieldErrors(error)), []);

	return { errors, clear, capture };
}
