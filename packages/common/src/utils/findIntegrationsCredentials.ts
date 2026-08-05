function findIntegrationsCredentials(
  integrations: {
    productRef: string;
    credentials: Record<string, unknown>;
  }[],
  engine: string
) {
  const integration = integrations.find(
    (i: { productRef: string }) => i.productRef === engine
  )?.credentials;

  if (!integration) {
    throw new Error(`Integration ${engine} not found`);
  }

  return integration;
}

export { findIntegrationsCredentials };
