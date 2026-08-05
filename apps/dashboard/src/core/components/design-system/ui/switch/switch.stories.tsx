import { fn } from "@storybook/test";
import { Switch } from "./switch";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * This story is for the Generic Toggle component based on MUI switch component
 * It takes a defaultValue, value, disabled and onChange.
 */
const meta = {
  title: "Components/Forms/Switch",
  component: Switch,
  parameters: {
    layout: "centered",
    design: {
      type: "figma",
      url: "https://www.figma.com/design/OsZlne0RvIgoFlFKF7hnAU/Shared-Component-Library?node-id=922-10844&m=dev"
    }
  },
  tags: ["autodocs"],
  args: { onChange: fn() },
  argTypes: {
    defaultValue: {
      name: "Default Value",
      control: "boolean",
      description: "The default value to use"
    },
    value: {
      name: "Value",
      control: "boolean",
      description: "The current value"
    },
    disabled: {
      name: "Disabled",
      description: "If true, the toggle will be disabled",
      control: "boolean"
    }
  }
} satisfies Meta<typeof Switch>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Example of a GenericToggle with defaultValue false.
 */
export const DefaultValueFalse: Story = {
  args: {
    defaultValue: false
  }
};

/**
 * Example of a GenericToggle with defaultValue true.
 */
export const DefaultValueTrue: Story = {
  args: {
    defaultValue: true
  }
};

/**
 * Example of a checked GenericToggle.
 */
export const Checked: Story = {
  args: {
    value: true
  }
};

/**
 * Example of a unchecked GenericToggle.
 */
export const Unchecked: Story = {
  args: {
    value: false
  }
};

/**
 * Example of a unchecked and disabled GenericToggle.
 */
export const UncheckedAndDisabled: Story = {
  args: {
    disabled: true,
    value: false
  }
};

/**
 * Example of a checked and disabled GenericToggle.
 */
export const CheckedAndDisabled: Story = {
  args: {
    disabled: true,
    value: true
  }
};
