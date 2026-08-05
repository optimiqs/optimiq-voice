import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Embeddings } from "@langchain/core/embeddings";
import { AbstractKnowledgeBase } from "./AbstractKnowledgeBase";

class FilesKnowledgeBase extends AbstractKnowledgeBase {
	constructor(private params: { embeddings?: Embeddings; files: string[] }) {
		super(params);
	}

	async getLoaders(): Promise<PDFLoader[]> {
		const { files } = this.params;

		if (!files.every((file) => file.endsWith(".pdf"))) {
			throw new Error("Only PDF files are supported");
		}

		return files.map((file: string) => new PDFLoader(file, { splitPages: false }));
	}
}

export { FilesKnowledgeBase };
