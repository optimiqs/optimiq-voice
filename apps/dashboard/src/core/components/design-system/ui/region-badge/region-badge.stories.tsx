import { RegionBadge } from "./region-badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * This story is for the regular Button component based on Material UI.
 * It has a contained variant and full width with optional start and end icons.
 */
const meta = {
	title: "Components/Icons, Badges, & Labels/Region Badge",
	component: RegionBadge,
	parameters: {
		layout: "centered",
		design: {
			type: "figma",
			url: "https://www.figma.com/design/OsZlne0RvIgoFlFKF7hnAU/Shared-Component-Library?node-id=301-13513",
		},
	},
	tags: ["autodocs"],
	argTypes: {
		children: {
			name: "Text",
			description: "The text to display",
		},
		type: {
			name: "Type",
			description: "The type of region label based on usage",
			control: {
				type: "select",
				options: ["landing-page", "drawer"],
			},
		},
	},
} satisfies Meta<typeof RegionBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Example of a RegionBadge for a drawer.
 */
export const DrawerExample: Story = {
	args: {
		children: "REGION",
		type: "drawer",
	},
};

/**
 * Example of a RegionBadge for a landing page.
 */
export const LandingPageExample: Story = {
	args: {
		children: "REGION",
		type: "landing-page",
	},
};
