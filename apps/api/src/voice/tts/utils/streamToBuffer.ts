async function streamToBuffer(readableStream): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of readableStream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export { streamToBuffer };
