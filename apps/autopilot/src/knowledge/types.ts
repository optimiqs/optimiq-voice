import { Embeddings } from "@langchain/core/embeddings";

type KnowledgeBase = {
  load: () => Promise<void>;
  queryKnowledgeBase: (query: string, k?: number) => Promise<string>;
};

type S3KnowledgeBaseParams = {
  embeddings?: Embeddings;
  bucket: string;
  documents: string[];
  s3Config: {
    endpoint: string;
    region: string;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
    };
    forcePathStyle: boolean;
  };
  unstructuredAPIURL: string;
  unstructuredAPIKey: string;
};

export { KnowledgeBase, S3KnowledgeBaseParams };
