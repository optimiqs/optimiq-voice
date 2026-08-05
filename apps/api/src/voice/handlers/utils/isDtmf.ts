function isDtmf(digit: string) {
	return /^[0-9*#]+$/.test(digit);
}

export { isDtmf };
