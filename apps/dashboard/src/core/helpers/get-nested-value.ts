/**
 * Safely retrieves a nested value from an object using a dot-separated key string.
 *
 * @param obj - The object to extract the value from.
 * @param key - A dot-separated key string, e.g. "speechToText.productRef".
 * @returns The value at the specified path, or undefined if not found.
 */
export function getNestedValue(
  obj: Record<string, any>,
  key: string
): string | undefined {
  const data = key.split(".").reduce((acc, part) => acc?.[part], obj);

  return data !== undefined
    ? Array.isArray(data)
      ? data.join(", ")
      : String(data)
    : undefined;
}
