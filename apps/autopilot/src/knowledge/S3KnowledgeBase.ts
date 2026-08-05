import { S3Loader } from "@langchain/community/document_loaders/web/s3";
import { AbstractKnowledgeBase } from "./AbstractKnowledgeBase";
import { S3KnowledgeBaseParams } from "./types";

class S3KnowledgeBase extends AbstractKnowledgeBase {
	constructor(private params: S3KnowledgeBaseParams) {
		super(params);
	}

	async getLoaders(): Promise<S3Loader[]> {
		const { documents } = this.params;
		if (!documents.every((file) => file.endsWith(".pdf"))) {
			throw new Error("Only PDF files are supported");
		}

		const { bucket, s3Config, unstructuredAPIURL, unstructuredAPIKey } = this.params;

		return documents.map(
			(document) =>
				new S3Loader({
					bucket,
					key: document,
					s3Config,
					unstructuredAPIURL,
					unstructuredAPIKey,
				}),
		);
	}
}

export { S3KnowledgeBase };
