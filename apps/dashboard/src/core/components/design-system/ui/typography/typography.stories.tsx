import { Typography } from "./typography";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
	title: "Components/Typography",
	component: Typography,
	argTypes: {
		variant: {
			name: "Variant",
			description: "The variant of the typography.",
			control: {
				type: "select",
				options: [
					"heading-large",
					"heading-medium",
					"heading-small",
					"body-large",
					"body-medium",
					"body-small",
					"body-small-underline",
					"body-micro",
					"mono-medium",
					"mono-medium-underline",
					"mono-small",
					"drawer-title",
					"drawer-label",
				],
			},
		},
	},
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
} satisfies Meta<typeof Typography>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Body/Large.
 */
export const BodyLarge: Story = {
	args: {
		variant: "body-large",
		children: "Body/Large",
	},
};

/**
 * Body/Medium.
 */
export const BodyMedium: Story = {
	args: {
		variant: "body-medium",
		children: "Body/Medium",
	},
};

/**
 * Body/Micro.
 */
export const BodyMicro: Story = {
	args: {
		variant: "body-micro",
		children: "Body/Micro",
	},
};

/**
 * Body/Small.
 */
export const BodySmall: Story = {
	args: {
		variant: "body-small",
		children: "Body/Small",
	},
};

/**
 * Body/Small Underline.
 */
export const BodySmallUnderline: Story = {
	args: {
		variant: "body-small-underline",
		children: "Body/Small Underline",
	},
};

/**
 * Drawer Label.
 */
export const DrawerLabel: Story = {
	args: {
		variant: "drawer-label",
		children: "Drawer Label",
	},
};

/**
 * Drawer Title.
 */
export const DrawerTitle: Story = {
	args: {
		variant: "drawer-title",
		children: "Drawer Title",
	},
};

/**
 * Heading/Large.
 */
export const HeadingLarge: Story = {
	args: {
		variant: "heading-large",
		children: "Heading/Large",
	},
};

/**
 * Heading/Medium.
 */
export const HeadingMedium: Story = {
	args: {
		variant: "heading-medium",
		children: "Heading/Medium",
	},
};

/**
 * Heading/Small.
 */
export const HeadingSmall: Story = {
	args: {
		variant: "heading-small",
		children: "Heading/Small",
	},
};

/**
 * Mono/Medium.
 */
export const MonoMedium: Story = {
	args: {
		variant: "mono-medium",
		children: "Mono/Medium",
	},
};

/**
 * Mono/Medium Underline.
 */
export const MonoMediumUnderline: Story = {
	args: {
		variant: "mono-medium-underline",
		children: "Mono/Medium Underline",
	},
};

/**
 * Mono/Small.
 */
export const MonoSmall: Story = {
	args: {
		variant: "mono-small",
		children: "Mono/Small",
	},
};
