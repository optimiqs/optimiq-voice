import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `tailwind-merge` cannot know about the semantic shadow scale declared in `app/globals.css`,
 * so it would let `shadow-raised shadow-overlay` both survive. Declaring the group makes the
 * later class win, the same way it does for Tailwind's own utilities.
 */
const twMerge = extendTailwindMerge({
	extend: {
		classGroups: {
			shadow: [{ shadow: ["raised", "overlay", "popover"] }],
		},
	},
});

/** Conditional class names with Tailwind conflict resolution. The only way to compose classes. */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
