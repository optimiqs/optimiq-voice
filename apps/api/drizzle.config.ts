import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/core/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.API_DATABASE_URL ?? "",
	},
});
