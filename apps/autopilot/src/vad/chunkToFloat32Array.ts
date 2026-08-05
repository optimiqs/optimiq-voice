function chunkToFloat32Array(chunk: Uint8Array): Float32Array {
  // Create a DataView to handle endianness explicitly
  const dataView = new DataView(
    chunk.buffer,
    chunk.byteOffset,
    chunk.byteLength
  );
  const floatArray = new Float32Array(chunk.byteLength / 2);

  // Convert each 16-bit sample to float32, explicitly handling little-endian
  for (let i = 0; i < floatArray.length; i++) {
    // Read 16-bit value with explicit little-endian
    const int16Value = dataView.getInt16(i * 2, true); // true = little-endian
    // Normalize to [-1, 1]
    floatArray[i] = int16Value / 32768.0;
  }

  return floatArray;
}

export { chunkToFloat32Array };
