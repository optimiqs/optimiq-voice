type Uri = {
  transport: string;
  host: string;
  port: number;
};

function getOutboundUri(uris: Uri[]): string {
  const uri = uris[0];
  if (!uri) {
    return "";
  }
  return `${uri.transport.toLowerCase()}://${uri.host}:${uri.port}`;
}

export { getOutboundUri };
