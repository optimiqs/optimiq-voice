import { Button } from "../button/button";
import { Tooltip } from "./tooltip";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
	title: "Components/Modals & Popups/Tooltip",
	component: Tooltip,
	tags: ["autodocs"],
	args: {
		title: "This is a tooltip",
	},
	argTypes: {
		title: {
			name: "Tooltip Text",
			description: "The content displayed inside the tooltip.",
			control: { type: "text" },
			table: {
				defaultValue: {
					summary: "This is a tooltip",
				},
			},
		},
		placement: {
			name: "Placement",
			description: "Position of the tooltip relative to the child element.",
			control: { type: "select" },
			options: [
				"top",
				"bottom",
				"left",
				"right",
				"top-start",
				"top-end",
				"bottom-start",
				"bottom-end",
				"left-start",
				"left-end",
				"right-start",
				"right-end",
			],
			table: {
				defaultValue: {
					summary: "top",
				},
			},
		},
		arrow: {
			name: "Arrow",
			description: "Whether the tooltip has an arrow.",
			control: { type: "boolean" },
			table: {
				defaultValue: {
					summary: "true",
				},
			},
		},
	},
	parameters: {
		layout: "centered",
		design: {
			type: "figma",
			url: "https://www.figma.com/file/XXXXXX/Optimiq Voice-Design-System",
		},
	},
} satisfies Meta<typeof Tooltip>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Tooltip with default placement on top.
 */
export const Default: Story = {
	args: {
		children: <Button>Hover me</Button>,
	},
};

/**
 * Tooltip with arrow and bottom placement.
 */
export const BottomArrow: Story = {
	args: {
		placement: "bottom",
		children: <Button>Bottom Tooltip</Button>,
	},
};

/**
 * Tooltip without arrow.
 */
export const NoArrow: Story = {
	args: {
		arrow: false,
		children: <Button>No Arrow Tooltip</Button>,
	},
};

/**
 * Long content inside the tooltip.
 */
export const LongText: Story = {
	args: {
		title:
			"This is a longer tooltip text to demonstrate how the component behaves with larger content.",
		placement: "right",
		children: <Button>Hover for long text</Button>,
	},
};
