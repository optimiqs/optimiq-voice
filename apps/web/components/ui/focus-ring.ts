/**
 * The one focus treatment in the design system.
 *
 * Every interactive primitive composes this string rather than declaring its own ring, so the
 * keyboard affordance is identical across buttons, inputs, select triggers, menu items and links
 * — and so removing it anywhere is a visible, reviewable diff instead of a silent `outline-none`.
 *
 * `focus-visible` (not `focus`) keeps the ring off mouse clicks while guaranteeing it for keyboard
 * and assistive-technology navigation.
 */
export const focusRing =
	"outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** For controls whose ring must sit inside the element (table rows, list items, sidebar links). */
export const focusRingInset =
	"outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
