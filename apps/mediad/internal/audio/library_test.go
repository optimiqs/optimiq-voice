package audio_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

func TestLibraryRefusesWithoutARoot(t *testing.T) {
	// An instance with no MEDIAD_SOUNDS_DIR must REFUSE every play rather than answer ok and send
	// nothing. The engine turns this into `not_supported` and routes the leg to Asterisk.
	library := audio.NewLibrary("")
	if library.Configured() {
		t.Fatal("Configured() is true with no root")
	}
	if _, err := library.Resolve("sound:welcome"); !errors.Is(err, audio.ErrNoLibrary) {
		t.Fatalf("Resolve error = %v, want ErrNoLibrary", err)
	}
}

func TestLibraryResolve(t *testing.T) {
	root := t.TempDir()
	library := audio.NewLibrary(root)

	tests := []struct {
		name string
		ref  string
		want string
		err  error
	}{
		{
			// The engine strips the extension on the way out (media-refs.ts), so this is the shape
			// nearly every real reference arrives in.
			name: "a bare name gets .wav appended",
			ref:  "sound:welcome",
			want: filepath.Join(root, "welcome.wav"),
		},
		{
			name: "an explicit extension is kept",
			ref:  "sound:welcome.wav",
			want: filepath.Join(root, "welcome.wav"),
		},
		{
			name: "a nested prompt resolves under the root",
			ref:  "sound:prompts/en/menu",
			want: filepath.Join(root, "prompts/en/menu.wav"),
		},
		{
			// What `object://` renders to when a deployment shares one mount with Asterisk.
			name: "an absolute path inside the root is accepted",
			ref:  "sound:" + filepath.Join(root, "voicemail/greeting"),
			want: filepath.Join(root, "voicemail/greeting.wav"),
		},
		{
			name: "surrounding whitespace is trimmed",
			ref:  "  sound:welcome  ",
			want: filepath.Join(root, "welcome.wav"),
		},
		{
			name: "traversal is refused",
			ref:  "sound:../../etc/passwd",
			err:  audio.ErrOutsideLibrary,
		},
		{
			name: "an absolute path outside the root is refused",
			ref:  "sound:/etc/passwd",
			err:  audio.ErrOutsideLibrary,
		},
		{
			// Asterisk's generators. Refused BY NAME so a failed call says the capability was
			// missing rather than the file.
			name: "tone: is refused as a generator",
			ref:  "tone://ring",
			err:  audio.ErrUnsupportedScheme,
		},
		{
			name: "digits: is refused as a generator",
			ref:  "digits:1234",
			err:  audio.ErrUnsupportedScheme,
		},
		{
			name: "a bare word with no scheme is refused",
			ref:  "welcome",
			err:  audio.ErrUnsupportedScheme,
		},
		{
			name: "sound: with no path is refused",
			ref:  "sound:",
			err:  audio.ErrNotFound,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := library.Resolve(test.ref)
			if test.err != nil {
				if !errors.Is(err, test.err) {
					t.Fatalf("Resolve(%q) error = %v, want %v", test.ref, err, test.err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%q): %v", test.ref, err)
			}
			if got != test.want {
				t.Errorf("Resolve(%q) = %q, want %q", test.ref, got, test.want)
			}
		})
	}
}

func TestLibraryLoadAndConcatenate(t *testing.T) {
	root := t.TempDir()
	writePrompt(t, root, "one.wav", 1)
	writePrompt(t, root, "two.wav", 2)
	library := audio.NewLibrary(root)

	clip, err := library.LoadAll([]string{"sound:one", "sound:two"}, audio.EncodingULaw)
	if err != nil {
		t.Fatalf("LoadAll: %v", err)
	}
	if len(clip.Frames) != 3 {
		t.Fatalf("frames = %d, want 3 (one + two)", len(clip.Frames))
	}
	if clip.DurationMs() != 60 {
		t.Errorf("DurationMs = %d, want 60", clip.DurationMs())
	}
}

func TestLibraryLoadAllFailsWholeRequestOnOneBadRef(t *testing.T) {
	// Half a sentence is worse than no sentence: a prompt list that dropped its middle clause would
	// play "your call is important" and then stop.
	root := t.TempDir()
	writePrompt(t, root, "one.wav", 1)
	library := audio.NewLibrary(root)

	_, err := library.LoadAll([]string{"sound:one", "sound:missing"}, audio.EncodingULaw)
	if !errors.Is(err, audio.ErrNotFound) {
		t.Fatalf("LoadAll error = %v, want ErrNotFound", err)
	}
}

func TestLibraryLoadAllRefusesAnEmptyList(t *testing.T) {
	library := audio.NewLibrary(t.TempDir())
	if _, err := library.LoadAll(nil, audio.EncodingULaw); err == nil {
		t.Fatal("LoadAll(nil) succeeded; a play of nothing must refuse")
	}
}

func TestLibraryLoadReportsADecodeFailureWithTheReference(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "broken.wav"), []byte("definitely not a wav"), 0o600); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	library := audio.NewLibrary(root)

	_, err := library.Load("sound:broken", audio.EncodingULaw)
	if !errors.Is(err, audio.ErrNotRIFF) {
		t.Fatalf("Load error = %v, want ErrNotRIFF", err)
	}
	// The reference has to be in the message: an operator reading a failed call needs to know WHICH
	// prompt, and the path is an implementation detail of this instance's mount.
	if got := err.Error(); !strings.Contains(got, "sound:broken") {
		t.Errorf("error %q does not name the reference", got)
	}
}

// writePrompt writes a µ-law WAV of `frames` 20 ms frames.
func writePrompt(t *testing.T, root, name string, frames int) {
	t.Helper()
	payload := make([]byte, frames*audio.FrameSamples)
	for index := range payload {
		payload[index] = 0xFF
	}
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("creating the prompt directory: %v", err)
	}
	if err := os.WriteFile(path, buildWAV(7, 1, 8000, 8, payload), 0o600); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}
