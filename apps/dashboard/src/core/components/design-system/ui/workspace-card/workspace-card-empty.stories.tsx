import { Box } from "@mui/material";
import { fn } from "@storybook/test";
import { AddWorkspaceCard } from "./workspace-card-empty";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * This story is for the WorkspaceCard component based on Material UI.
 * It supports both regular and empty variants and can be disabled.
 */
const meta = {
  title: "Components/Workspaces/Add Workspace Card",
  component: AddWorkspaceCard,
  parameters: {
    layout: "centered",
    design: {
      type: "figma",
      url: "https://www.figma.com/design/OsZlne0RvIgoFlFKF7hnAU/Shared-Component-Library?node-id=8-8505&p=f&t=NCJIzjsjMFiDAc1s-0"
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof AddWorkspaceCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Example of a regular WorkspaceCard with region, description, and date
 */
export const RegularCard: Story = {
  args: {
    disabled: false,
    onClick: fn()
  },
  render: (args) => (
    <Box sx={{ maxWidth: "325px", width: "100%", margin: "0 auto" }}>
      <AddWorkspaceCard {...args} />
    </Box>
  )
};
