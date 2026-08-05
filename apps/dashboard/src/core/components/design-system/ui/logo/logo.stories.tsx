import { Logo } from "./logo";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * This story is for the Logo component which is used for branding in the app.
 */
const meta = {
	title: "Components/Icons, Badges, & Labels/Logo",
	component: Logo,
	parameters: {
		layout: "centered",
		design: {
			type: "figma",
			url: "https://www.figma.com/design/OsZlne0RvIgoFlFKF7hnAU/Shared-Component-Library?node-id=8-8510",
		},
	},
	tags: ["autodocs"],
	argTypes: {
		size: {
			name: "Size",
			description: "The type of logo to render",
			control: {
				type: "select",
				options: ["micro", "large"],
			},
		},
	},
} satisfies Meta<typeof Logo>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Example of a large logo
 */
export const LargeLogo: Story = {
	args: {
		size: "large",
	},
};

/**
 * Example of a micro logo
 */
export const MicroLogo: Story = {
	args: {
		size: "micro",
	},
};
