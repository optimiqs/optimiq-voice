const CLAUSE_BOUNDARIES = /[.?!;]+/g;

function textChunkTextByClause(text: string) {
	const boundaries = [...text.matchAll(CLAUSE_BOUNDARIES)];
	const chunks = [];
	let start = 0;

	for (let i = 0; i < boundaries.length; i++) {
		if (chunks.length >= 2) {
			break;
		}
		const boundary = boundaries[i];
		const end = boundary.index + boundary[0].length;
		chunks.push(text.slice(start, end).trim());
		start = end;
	}

	const remainingText = text.slice(start).trim();
	if (remainingText.length > 0) {
		chunks.push(remainingText);
	}

	return chunks;
}

export { textChunkTextByClause };
