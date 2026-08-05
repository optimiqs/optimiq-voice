import { PasswordStrengthBar } from "./password-strength-bar";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Components/Forms/Password Strength Bar",
  component: PasswordStrengthBar,
  parameters: {
    layout: "padded"
  },
  tags: ["autodocs"],
  argTypes: {
    password: {
      name: "Password",
      description: "The password to check strength for",
      control: { type: "text" },
      table: {
        defaultValue: {
          summary: ""
        }
      }
    }
  }
} satisfies Meta<typeof PasswordStrengthBar>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Empty password - no strength
 */
export const Empty: Story = {
  args: {
    password: ""
  }
};

/**
 * Weak password
 */
export const Weak: Story = {
  args: {
    password: "123"
  }
};

/**
 * Fair password
 */
export const Fair: Story = {
  args: {
    password: "password"
  }
};

/**
 * Good password
 */
export const Good: Story = {
  args: {
    password: "Password123"
  }
};

/**
 * Strong password
 */
export const Strong: Story = {
  args: {
    password: "MyStr0ng!P@ssw0rd"
  }
};
