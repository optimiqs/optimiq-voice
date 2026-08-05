/**
 * A list of searchable fields for filtering or querying api keys.
 *
 * Each item represents a property that users can search against in the UI.
 * This configuration is commonly used to populate dropdowns, filters, or
 * search bars where the user selects which field to search by.
 */
export const API_KEYS_SEARCHABLE_FIELDS = [
	/**
	 * Searchable by the api key's unique reference ID.
	 * Typically a UUID or internal identifier.
	 * Useful for precise lookups when the user knows the exact reference.
	 */
	{ label: "Reference", value: "ref" },

	/**
	 * Searchable by the api key's access key ID.
	 * This is the public identifier used to authenticate API requests.
	 * Useful for users who have the access key ID and want to find
	 * the corresponding api key quickly.
	 */
	{ label: "Access Key ID", value: "accessKeyId" },
];
