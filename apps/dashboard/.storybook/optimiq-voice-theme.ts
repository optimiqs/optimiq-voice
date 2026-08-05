import { create } from "@storybook/theming/create";

export default create({
	base: "light",
	brandTitle: "Optimiq Voice Design System",
	brandUrl: "https://optimiq.health",
	brandTarget: "_self",

	colorPrimary: "#39E19E",
	colorSecondary: "#053204",

	// UI
	appBg: "#ffffff",
	appContentBg: "#ffffff",
	appBorderColor: "#E5E5E5",
	appBorderRadius: 8,

	// Typography
	fontBase: '"Inter", sans-serif',
	fontCode: "monospace",

	// Text colors
	textColor: "#1A1A1A",
	textInverseColor: "#ffffff",

	// Toolbar default and active colors
	barTextColor: "#1A1A1A",
	barSelectedColor: "#39E19E",
	barBg: "#ffffff",

	// Form colors
	inputBg: "#ffffff",
	inputBorder: "#E5E5E5",
	inputTextColor: "#1A1A1A",
	inputBorderRadius: 8,
});
