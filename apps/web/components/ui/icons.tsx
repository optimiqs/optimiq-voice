import type { ComponentProps, ReactNode } from "react";

/**
 * The app's icon set, inline.
 *
 * A phone-system admin needs roughly fifteen glyphs; pulling a 1,000-icon package for that costs
 * a dependency, a tree-shaking assumption and a second source of stroke conventions. These are
 * hand-drawn on one grid: 24px viewBox, 1.5 stroke, round caps and joins, `currentColor`. Adding
 * one means matching that, not pasting a different library's geometry.
 *
 * Every icon is `aria-hidden` — an icon next to a label is decorative, and an icon-only control
 * must carry its own `aria-label` at the call site.
 */

type IconProps = Omit<ComponentProps<"svg">, "children">;

function Glyph({ children, ...props }: IconProps & { children: ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...props}
		>
			{children}
		</svg>
	);
}

export function GaugeIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
			<path d="m13.4 10.6 3.6-3.6" />
			<path d="M4 18a9 9 0 1 1 16 0" />
		</Glyph>
	);
}

export function PhoneIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M6.5 3h-2A1.5 1.5 0 0 0 3 4.6C3 13.1 10.9 21 19.4 21a1.5 1.5 0 0 0 1.6-1.5v-2a1 1 0 0 0-.8-1l-3.3-.7a1 1 0 0 0-1 .4l-.9 1.2a13.6 13.6 0 0 1-5.4-5.4l1.2-.9a1 1 0 0 0 .4-1l-.7-3.3a1 1 0 0 0-1-.8Z" />
		</Glyph>
	);
}

export function DeviceIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect x="6" y="2.5" width="12" height="19" rx="2.5" />
			<path d="M10.5 18.5h3" />
		</Glyph>
	);
}

export function HashIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
		</Glyph>
	);
}

export function TrunkIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M12 3v6" />
			<circle cx="12" cy="11" r="2" />
			<path d="M12 13v3M6 21v-3a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" />
		</Glyph>
	);
}

export function RouteIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="6" cy="18" r="2.5" />
			<circle cx="18" cy="6" r="2.5" />
			<path d="M6 15.5V9a3 3 0 0 1 3-3h6.5" />
		</Glyph>
	);
}

export function MenuIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M7 9h4M7 13h6" />
		</Glyph>
	);
}

export function UsersIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="9" cy="8" r="3" />
			<path d="M3 20a6 6 0 0 1 12 0" />
			<path d="M16 5.5a3 3 0 0 1 0 5.8M17 14.2A6 6 0 0 1 21 20" />
		</Glyph>
	);
}

export function QueueIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M4 6h16M4 12h16M4 18h10" />
			<circle cx="18.5" cy="18" r="2" />
		</Glyph>
	);
}

export function VoicemailIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="6.5" cy="12" r="3.5" />
			<circle cx="17.5" cy="12" r="3.5" />
			<path d="M6.5 15.5h11" />
		</Glyph>
	);
}

export function ConferenceIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="12" cy="7" r="2.5" />
			<circle cx="5.5" cy="15" r="2.5" />
			<circle cx="18.5" cy="15" r="2.5" />
			<path d="M10.2 8.9 7.3 13M13.8 8.9l2.9 4.1M8 15.5h8" />
		</Glyph>
	);
}

/** Call park: the parking "P" on a sign, because that is the metaphor the feature is named for. */
export function ParkIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect x="3" y="3" width="18" height="18" rx="4" />
			<path d="M10 16.5v-9h3.25a2.75 2.75 0 0 1 0 5.5H10" />
		</Glyph>
	);
}

export function RecordIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect x="9" y="2.5" width="6" height="11" rx="3" />
			<path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
		</Glyph>
	);
}

export function HistoryIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
			<path d="M3 4v4h4" />
			<path d="M12 8v4.5l3 1.8" />
		</Glyph>
	);
}

export function SettingsIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="12" cy="12" r="3" />
			<path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
		</Glyph>
	);
}

export function KeyIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="8" cy="16" r="3.5" />
			<path d="m10.5 13.5 8-8M16.5 7.5l2 2M14.5 9.5l2 2" />
		</Glyph>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="m4.5 12.5 5 5 10-11" />
		</Glyph>
	);
}

export function ChevronDownIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="m6 9 6 6 6-6" />
		</Glyph>
	);
}

export function PlusIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M12 5v14M5 12h14" />
		</Glyph>
	);
}

export function LogOutIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
			<path d="M10 8 6 12l4 4M6 12h9" />
		</Glyph>
	);
}

export function BuildingIcon(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect x="4" y="3" width="16" height="18" rx="2" />
			<path d="M8 7h2M14 7h2M8 11h2M14 11h2M10 21v-4h4v4" />
		</Glyph>
	);
}
