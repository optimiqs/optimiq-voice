/**
 * Converts a string to title case.
 *
 * @param str - The string to convert.
 * @returns The string in title case.
 */
export const toTitleCase = (str: string) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : "";
