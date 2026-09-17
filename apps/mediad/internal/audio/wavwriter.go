package audio

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

// The WAV writer half of this package. Unlike the reader, which walks chunks because real files are
// not canonical, the writer emits exactly the canonical 44-byte PCM header.

// The fixed geometry of what mediad writes: 16-bit linear PCM, mono, 8 kHz.
//
// Linear rather than the G.711 the leg negotiated because a `both` recording has to sum two streams
// (only defined in the linear domain), µ-law-in-WAV is played unevenly by download clients, and one
// law is wrong once two legs answer differently.
const (
	wavBitsPerSample = 16
	wavChannels      = 1
	wavBytesPerFrame = wavChannels * wavBitsPerSample / 8
	// wavHeaderBytes is the canonical RIFF/WAVE PCM header: 12 of RIFF, 24 of fmt, 8 of data.
	wavHeaderBytes = 44
	// wavWriteBuffer is one second of audio: one write syscall a second rather than fifty.
	wavWriteBuffer = SampleRate * wavBytesPerFrame
)

// PartialSuffix is appended to a recording's path while it is being written, and the file is
// renamed on Close. The final path must never name an incomplete file: `apps/api`'s archiver copies
// whatever is at the object key as soon as `channel.record.stopped` lands. A rename within one
// directory is atomic, and a leftover `.partial` is an unambiguous marker of an interrupted
// recording.
const PartialSuffix = ".partial"

// WAVWriter streams 16-bit linear samples into a RIFF/WAVE file. Not safe for concurrent use: one
// recording owns one writer and writes from one goroutine.
type WAVWriter struct {
	path    string
	partial string
	file    *os.File
	buffer  *bufio.Writer
	samples int64
	closed  bool
}

// CreateWAV opens a recording for writing, creating its parent directories. The header written here
// is a placeholder with zero length fields; Close patches them once the length is known.
func CreateWAV(path string) (*WAVWriter, error) {
	if path == "" {
		return nil, fmt.Errorf("audio: a recording path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("audio: creating the recording directory for %s: %w", path, err)
	}

	partial := path + PartialSuffix
	// O_EXCL rather than O_TRUNC, so two recordings racing for one reference fail loudly rather
	// than the second destroying the first's audio.
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o640)
	if err != nil {
		return nil, fmt.Errorf("audio: creating %s: %w", partial, err)
	}

	writer := &WAVWriter{
		path:    path,
		partial: partial,
		file:    file,
		buffer:  bufio.NewWriterSize(file, wavWriteBuffer),
	}
	if _, err := writer.buffer.Write(wavHeader(0)); err != nil {
		_ = writer.Abort()
		return nil, fmt.Errorf("audio: writing the header of %s: %w", partial, err)
	}
	return writer, nil
}

// Path is where the finished file will land.
func (w *WAVWriter) Path() string { return w.path }

// Samples is how many samples have been handed over.
func (w *WAVWriter) Samples() int64 { return w.samples }

// DurationMs is how much audio has been written.
func (w *WAVWriter) DurationMs() int { return int(w.samples * 1000 / SampleRate) }

// WriteSamples appends one frame of 16-bit linear audio.
func (w *WAVWriter) WriteSamples(samples []int16) error {
	if w.closed {
		return fmt.Errorf("audio: %s is already closed", w.path)
	}
	var encoded [2]byte
	for _, sample := range samples {
		binary.LittleEndian.PutUint16(encoded[:], uint16(sample))
		if _, err := w.buffer.Write(encoded[:]); err != nil {
			return fmt.Errorf("audio: writing audio to %s: %w", w.partial, err)
		}
	}
	w.samples += int64(len(samples))
	return nil
}

// Close finalises the file and returns its size in bytes. The order is load-bearing: flush, patch
// the length fields, fsync (a rename is atomic against other readers, not against a crash), close,
// then rename into the final path. A failure anywhere removes the partial rather than leaving a
// file that would be archived as a real recording.
func (w *WAVWriter) Close() (int64, error) {
	if w.closed {
		return 0, fmt.Errorf("audio: %s is already closed", w.path)
	}
	w.closed = true

	if err := w.buffer.Flush(); err != nil {
		return 0, w.abortWith(fmt.Errorf("audio: flushing %s: %w", w.partial, err))
	}

	dataBytes := w.samples * wavBytesPerFrame
	if dataBytes > int64(^uint32(0))-wavHeaderBytes {
		// Unreachable under the contract's four-hour cap, but a wrapped RIFF length would give a
		// file that plays a fraction of itself with no error anywhere.
		return 0, w.abortWith(fmt.Errorf("audio: %s is too long for a RIFF length field", w.partial))
	}
	if _, err := w.file.WriteAt(wavHeader(uint32(dataBytes)), 0); err != nil {
		return 0, w.abortWith(fmt.Errorf("audio: patching the header of %s: %w", w.partial, err))
	}
	if err := w.file.Sync(); err != nil {
		return 0, w.abortWith(fmt.Errorf("audio: syncing %s: %w", w.partial, err))
	}
	if err := w.file.Close(); err != nil {
		return 0, w.abortWith(fmt.Errorf("audio: closing %s: %w", w.partial, err))
	}
	if err := os.Rename(w.partial, w.path); err != nil {
		_ = os.Remove(w.partial)
		return 0, fmt.Errorf("audio: publishing %s: %w", w.path, err)
	}
	return dataBytes + wavHeaderBytes, nil
}

// Abort closes the file and removes the partial. The final path is never created.
func (w *WAVWriter) Abort() error {
	if w.closed {
		return nil
	}
	w.closed = true
	err := w.file.Close()
	if removeErr := os.Remove(w.partial); removeErr != nil && err == nil {
		err = removeErr
	}
	return err
}

// abortWith removes the partial and returns the original failure, never the cleanup's.
func (w *WAVWriter) abortWith(cause error) error {
	_ = w.file.Close()
	_ = os.Remove(w.partial)
	return cause
}

// wavHeader builds the canonical 44-byte RIFF/WAVE PCM header for a data chunk of the given size.
func wavHeader(dataBytes uint32) []byte {
	header := make([]byte, wavHeaderBytes)
	copy(header[0:4], "RIFF")
	// Everything after this field: 4 of "WAVE", 24 of fmt, 8 of the data header, then the audio.
	binary.LittleEndian.PutUint32(header[4:8], wavHeaderBytes-8+dataBytes)
	copy(header[8:12], "WAVE")

	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:20], 16) // a PCM fmt chunk is 16 bytes
	binary.LittleEndian.PutUint16(header[20:22], waveFormatPCM)
	binary.LittleEndian.PutUint16(header[22:24], wavChannels)
	binary.LittleEndian.PutUint32(header[24:28], SampleRate)
	binary.LittleEndian.PutUint32(header[28:32], SampleRate*wavBytesPerFrame) // byte rate
	binary.LittleEndian.PutUint16(header[32:34], wavBytesPerFrame)            // block align
	binary.LittleEndian.PutUint16(header[34:36], wavBitsPerSample)

	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:44], dataBytes)
	return header
}

// DecodeLinear turns one G.711 frame into 16-bit linear samples. Exported for internal/rtp's
// recorder.
func DecodeLinear(payload []byte, encoding Encoding) []int16 {
	return decodeLinearInto(make([]int16, len(payload)), payload, encoding)
}

// decodeLinearInto is DecodeLinear writing into a caller-supplied buffer, for the packet path.
// `dst` is grown when it is too short, and sliced to the payload's length when it is longer.
func decodeLinearInto(dst []int16, payload []byte, encoding Encoding) []int16 {
	samples := dst
	if cap(samples) < len(payload) {
		samples = make([]int16, len(payload))
	}
	samples = samples[:len(payload)]
	if encoding == EncodingALaw {
		for index, encoded := range payload {
			samples[index] = ALawToLinear(encoded)
		}
		return samples
	}
	for index, encoded := range payload {
		samples[index] = ULawToLinear(encoded)
	}
	return samples
}

// MixInto sums one frame of linear audio into another, saturating rather than wrapping: two streams
// at full scale sum past int16, and a wrap would turn a loud moment into a full-amplitude sign flip.
func MixInto(destination, source []int16) {
	limit := min(len(destination), len(source))
	for index := range limit {
		sum := int32(destination[index]) + int32(source[index])
		switch {
		case sum > 32767:
			sum = 32767
		case sum < -32768:
			sum = -32768
		}
		destination[index] = int16(sum)
	}
}
