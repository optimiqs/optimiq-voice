import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Storybook-specific Vite config without React Router
export default defineConfig({
	plugins: [
		tsconfigPaths({
			projects: ["./tsconfig.json"],
		}),
	],
	resolve: {
		alias: {
			"react-router": "react-router/dist/react-router.production.min.js",
		},
	},
	optimizeDeps: {
		include: [
			"@emotion/react",
			"@emotion/styled",
			"@mui/material",
			"@mui/icons-material",
			"@tanstack/react-query",
			"react",
			"react-dom",
		],
		exclude: [
			"@react-router/dev",
			"@react-router/node",
			"@react-router/serve",
			"react-router-devtools",
		],
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify("development"),
	},
});
