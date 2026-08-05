import { action } from "@storybook/addon-actions";
import Sidebar from "./sidebar";
import type { Workspace } from "./sidebar.interfaces";
import type { Meta, StoryObj } from "@storybook/react";

const meta: Meta<typeof Sidebar> = {
	title: "Components/Layouts/Sidebar",
	component: Sidebar,
};

export default meta;

type Story = StoryObj<typeof Sidebar>;

const workspaces: Workspace[] = [
	{ id: "1", name: "Demo Workspace" },
	{ id: "2", name: "Default Workspace" },
	{ id: "3", name: "Bank Account" },
];

export const Default: Story = {
	args: {
		workspaces,
		selectedWorkspaceId: "1",
		onSelectWorkspace: action("onSelectWorkspace"),
		navigate: action("navigate"),
		pathname: "/workspaces/[workspaceId]/sip-network/domains",
	},
};
