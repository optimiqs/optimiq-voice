export default {
	"*.{js,jsx,ts,tsx,mjs,cjs}": ["oxlint --fix", "oxfmt"],
	"*.{json,jsonc,json5,yaml,yml,css,scss,less,html,md,mdx,hbs}": [
		"oxfmt --no-error-on-unmatched-pattern",
	],
};
