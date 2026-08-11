package audio

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
)

// The WAV writer half of this package: rung 4 of plans/mediad-design.md §2.
//
// It is the mirror image of the reader above it. The reader walks chunks because real files are not
// canonical; the writer emits exactly the canonical 44-byte PCM header, because the only consumer
// that matters is `apps/api`'s archiver — which copies bytes it never inspects — and a player at the
// other end of a download link. Writing anything more elaborate would be adding surface for no
// reader.

// The fixed geometry of what mediad writes. 16-bit linear PCM, mono, 8 kHz.
//
// LINEAR and not the G.711 the leg negotiated, even though that would be a byte-for-byte copy and
// half the size. Three reasons, in the order they bite: a `both` recording has to SUM two streams,
// which only exists in the linear domain; `apps/api` serves every recording as `audio/wav` and
// something at the far end has to play it, where µ-law-in-WAV is supported unevenly; and one law is
// wrong for the other half of a call the day two legs answer differently.
const (
	wavBitsPerSample = 16
	wavChannels      = 1
	wavBytesPerFrame = wavChannels * wavBitsPerSample / 8
	// wavHeaderBytes is the canonical RIFF/WAVE PCM header: 12 of RIFF, 24 of fmt, 8 of data.
	wavHeaderBytes = 44
	// wavWriteBuffer is one second of audio. Big enough that a recording costs 1 write syscall a
	// second rather than 50, small enough that a crash loses a second of a file nobody will read.
	wavWriteBuffer = SampleRate * wavBytesPerFrame
)

// PartialSuffix is appended to a recording's path while it is being written.
//
// # Why a rename rather than an in-place header patch
//
// Because the final path must NEVER name an incomplete file. `apps/api`'s archiver stats the object
// key the moment `channel.record.stopped` lands and copies whatever is there; a media plane that
// crashed mid-recording and left a plausible-looking WAV at the real path would have that file
// archived, downloaded, and found to be silence by the person who needed it. A rename within one
// directory is atomic on every filesystem this runs on, so the object key either does not exist or
// is a finished recording.
//
// It also makes a crash DETECTABLE rather than merely harmless: a `.partial` left behind is a
// recording that was interrupted, it is greppable, and it is nothing else.
const PartialSuffix = ".partial"

// WAVWriter streams 16-bit linear samples into a RIFF/WAVE file.
//
// Not safe for concurrent use. One recording owns one writer and writes from one goroutine, which
// is what keeps the sample counter and the buffered file position in agreement without a lock on a
// path that runs 50 times a second.
type WAVWriter struct {
	path    string
	partial string
	file    *os.File
	buffer  *bufio.Writer
	samples int64
	closed  bool
}

// CreateWAV opens a recording for writing, creating its parent directories.
//
// The header written here is a PLACEHOLDER: the two length fields are zero, because the length of a
// recording is not known until it ends. Close patches them. A reader that opened the partial file
// mid-recording would therefore see a well-formed WAV containing no audio — which is exactly the
// right answer for a file that is still being written, and why the partial carries a different name
// anyway.
func CreateWAV(path string) (*WAVWriter, error) {
	if path == "" {
		return nil, fmt.Errorf("audio: a recording path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("audio: creating the recording directory for %s: %w", path, err)
	}

	partial := path + PartialSuffix
	// O_EXCL rather than O_TRUNC: two recordings racing for one reference is a caller bug, and
	// truncating would make the second silently destroy the first's audio. Failing names it.
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

// Close finalises the file and returns its size in bytes.
//
// The order is the whole point and every step is load-bearing:
//
//  1. Flush the buffer, so every sample handed over is in the file rather than in this process.
//  2. Patch the two length fields, which is the only moment the real lengths are known.
//  3. fsync, so a machine that loses power after the rename still has the bytes the rename
//     promised. A rename is atomic with respect to other readers, not with respect to a crash.
//  4. Close, then rename into the final path. Only now does the object key exist.
//
// A failure anywhere removes the partial and reports it, rather than leaving a file that would be
// archived as a real recording.
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
		// A four-hour cap on the contract puts the ceiling at ~230 MB, three orders of magnitude
		// under this. Checked anyway, because the failure it prevents is a header claiming a length
		// it wrapped to — a file that opens and plays a fraction of itself with no error anywhere.
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

// DecodeLinear turns one G.711 frame into 16-bit linear samples.
//
// Exported because the recorder needs it and lives in internal/rtp: a recording is the reverse of a
// playback, and the companding tables are here.
func DecodeLinear(payload []byte, encoding Encoding) []int16 {
	samples := make([]int16, len(payload))
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

// MixInto sums one frame of linear audio into another, saturating rather than wrapping.
//
// Saturation is not a detail. Two G.711 streams at full scale sum past what an int16 holds, and a
// wrap turns a loud moment into a full-amplitude sign flip — which is not "slightly clipped", it is
// a bang. Clamping produces the mild distortion every mixer produces when two people shout at once.
func MixInto(destination, source []int16) {
	limit := len(destination)
	if len(source) < limit {
		limit = len(source)
	}
	for index := 0; index < limit; index++ {
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
