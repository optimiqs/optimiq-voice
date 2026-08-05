import { toTitleCase } from "./to-title-case";

/**
 * Formats an engine name by removing a prefix and applying toTitleCase.
 * Returns '-' if the productRef is missing.
 *
 * @param productRef - The product reference to format.
 * @param prefix - The prefix to remove from the product reference (e.g. "tts.", "stt.", "llm.").
 * @returns The formatted engine name, or '-' if the productRef is missing.
 */
export function formatEngineName(productRef: string | undefined, prefix: string): string {
	if (!productRef) return "";
	return toTitleCase(productRef.replace(prefix, ""));
}
