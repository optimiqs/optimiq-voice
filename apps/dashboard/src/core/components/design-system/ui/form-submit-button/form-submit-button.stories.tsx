import { action } from "@storybook/addon-actions";
import { FormSubmitButton } from "./form-submit-button";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Components/Forms/Form Submit Button",
  component: FormSubmitButton,
  parameters: {
    layout: "centered"
  },
  tags: ["autodocs"],
  argTypes: {
    isLoading: {
      name: "Is Loading",
      description: "Whether the button is in a loading state",
      control: { type: "boolean" },
      table: {
        defaultValue: {
          summary: "false"
        }
      }
    },
    disabled: {
      name: "Disabled",
      description: "Whether the button is disabled",
      control: { type: "boolean" },
      table: {
        defaultValue: {
          summary: "false"
        }
      }
    },
    children: {
      name: "Content",
      description: "The content of the button",
      control: { type: "text" },
      table: {
        defaultValue: {
          summary: "Submit"
        }
      }
    }
  }
} satisfies Meta<typeof FormSubmitButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Default form submit button
 */
export const Default: Story = {
  args: {
    children: "Submit",
    onClick: action("onClick")
  }
};

/**
 * Loading form submit button
 */
export const Loading: Story = {
  args: {
    children: "Submitting...",
    isLoading: true,
    onClick: action("onClick")
  }
};

/**
 * Disabled form submit button
 */
export const Disabled: Story = {
  args: {
    children: "Submit",
    disabled: true,
    onClick: action("onClick")
  }
};
