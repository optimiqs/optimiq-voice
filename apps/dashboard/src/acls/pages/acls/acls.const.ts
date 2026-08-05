/**
 * A list of searchable fields for filtering or querying ACLs.
 *
 * Each item represents a property that users can search against in the UI.
 * This configuration is commonly used to populate dropdowns, filters, or
 * search bars where the user selects which field to search by.
 */
export const ACLS_SEARCHABLE_FIELDS = [
  {
    /**
     * Searchable by the ACL's unique reference ID.
     *
     * Typically a UUID or internal identifier.
     * Useful for precise lookups when the user knows the exact reference.
     */
    label: "Reference",
    value: "ref"
  },
  {
    /**
     * Searchable by the ACL's name.
     *
     * This is a human-readable identifier for the ACL.
     * Useful for users who remember the name of the ACL
     * they are looking for.
     */
    label: "Name",
    value: "name"
  },

  {
    /**
     * Searchable by the ACL's allow list.
     *
     * This field contains a list of permissions or resources
     * that the ACL allows access to.
     * Useful for users who want to find ACLs
     */
    label: "Allow List",
    value: "allow"
  }
];
