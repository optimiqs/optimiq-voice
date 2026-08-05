const CLAUSE_BOUNDARIES = /[.?!;]+/g;

function textChunksByFirstNaturalPause(text: string) {
	const boundary = text.match(CLAUSE_BOUNDARIES)?.[0];
	if (!boundary) {
		// No pause found, return the entire text as the first chunk
		return [text.trim()];
	}

	const boundaryIndex = text.indexOf(boundary) + boundary.length;
	const firstChunk = text.slice(0, boundaryIndex).trim();
	const secondChunk = text.slice(boundaryIndex).trim();

	return secondChunk ? [firstChunk, secondChunk] : [firstChunk];
}

export { textChunksByFirstNaturalPause };
