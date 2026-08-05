/**
 * A list of searchable fields for filtering or querying agents.
 *
 * Each item represents a property that users can search against in the UI.
 * This configuration is commonly used to populate dropdowns, filters, or
 * search bars where the user selects which field to search by.
 */
export const AGENTS_SEARCHABLE_FIELDS = [
	/**
	 * Searchable by the agent's unique reference ID.
	 * Typically a UUID or internal identifier.
	 * Useful for precise lookups when the user knows the exact reference.
	 */
	{ label: "Reference", value: "ref" },

	/**
	 * Searchable by the agent's name.
	 * This is a human-readable identifier for the agent.
	 * Useful for users who remember the name of the agent
	 * they are looking for.
	 */
	{ label: "Name", value: "name" },

	/**
	 * Searchable by the agent's type.
	 * This could include types like "API Key", "OAuth Token", etc.
	 * Useful for filtering agents based on their type,
	 * especially in systems that support multiple agent types.
	 */
	{ label: "Username", value: "username" },
];
