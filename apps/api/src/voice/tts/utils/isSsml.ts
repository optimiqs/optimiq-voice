function isSsml(text: string) {
	const v = text.trim();
	return v.startsWith("<") && v.endsWith(">");
}

export { isSsml };
