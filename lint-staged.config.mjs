export default {
	// `--no-error-on-unmatched-pattern` on both tools: lint-staged passes the staged paths
	// verbatim, so a commit whose files all sit under an `ignorePatterns` entry (drizzle/,
	// generated/, apps/dashboard/, …) would otherwise abort the commit with
	// "No files found to lint".
	"*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}": [
		"oxlint --fix --no-error-on-unmatched-pattern",
		"oxfmt --no-error-on-unmatched-pattern",
	],
	"*.{json,jsonc,json5,yaml,yml,css,scss,less,html,md,mdx,hbs}": [
		"oxfmt --no-error-on-unmatched-pattern",
	],
};
