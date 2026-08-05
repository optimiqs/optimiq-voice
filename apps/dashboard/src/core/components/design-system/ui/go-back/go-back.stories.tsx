import { action } from "@storybook/addon-actions";
import { GoBackButton } from "./go-back";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
	title: "Components/Navigation/Go Back",
	component: GoBackButton,
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
	argTypes: {
		label: {
			name: "Label",
			description: "The text label for the go back button",
			control: { type: "text" },
			table: {
				defaultValue: {
					summary: "Go back",
				},
			},
		},
	},
} satisfies Meta<typeof GoBack>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Default go back button
 */
export const Default: Story = {
	args: {
		label: "Go back",
		onClick: action("onClick"),
	},
};

/**
 * Go back with custom label
 */
export const CustomLabel: Story = {
	args: {
		label: "Back to dashboard",
		onClick: action("onClick"),
	},
};

/**
 * Go back to specific page
 */
export const BackToList: Story = {
	args: {
		label: "Back to list",
		onClick: action("onClick"),
	},
};
