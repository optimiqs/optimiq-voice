type NumberPreconditionsCheck = (request: { appRef?: string; agentAor?: string }) => Promise<void>;

type IntegrationConfig = {
	productRef: string;
	credentials: Record<string, unknown>;
};

export { NumberPreconditionsCheck, IntegrationConfig };
