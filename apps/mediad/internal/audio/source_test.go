package audio_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

func TestLoadSourceResolvesEveryScheme(t *testing.T) {
	root := t.TempDir()
	writePrompt(t, root, "welcome.wav", 3)
	writePrompt(t, root, "menu.wav", 2)
	writePrompt(t, root, "moh/default.wav", 10)
	writePrompt(t, root, "moh/sales.wav", 4)
	library := audio.NewLibrary(root)

	cases := []struct {
		name      string
		refs      []string
		wantLoop  bool
		wantMs    int
		describes string
	}{
		{
			name:      "one prompt does not loop",
			refs:      []string{"sound:welcome"},
			wantMs:    60,
			describes: "sound:welcome",
		},
		{
			// ARI plays a list in sequence and concatenating is the same audio with none of the
			// scheduling gap a queue would put between the clauses of one sentence.
			name:      "several prompts concatenate",
			refs:      []string{"sound:welcome", "sound:menu"},
			wantMs:    100,
			describes: "sound:welcome+sound:menu",
		},
		{
			// Hold music repeats, and it repeats because it is hold music — not because a caller
			// asked for a loop. That is the whole reason the flag is derived from the scheme.
			name:      "music on hold loops",
			refs:      []string{"moh:default"},
			wantLoop:  true,
			wantMs:    200,
			describes: "moh:default",
		},
		{
			name:      "a named music class",
			refs:      []string{"moh:sales"},
			wantLoop:  true,
			wantMs:    80,
			describes: "moh:sales",
		},
		{
			// The class Asterisk's own `channels.startMoh()` uses when the engine names none, so one
			// engine-side setting serves both planes during the cutover.
			name:      "moh with no class is the default class",
			refs:      []string{"moh:"},
			wantLoop:  true,
			wantMs:    200,
			describes: "moh:default",
		},
		{
			// A cadence describes a state that persists. A ringback that played once and stopped
			// would tell a caller the far end had given up.
			name:      "a cadenced tone loops",
			refs:      []string{"tone:busy"},
			wantLoop:  true,
			wantMs:    1000,
			describes: "tone:busy",
		},
		{
			// A beep is a MARKER. Repeating it would talk over the message it exists to introduce.
			name:      "a one-shot tone does not loop",
			refs:      []string{"tone:beep"},
			wantMs:    260,
			describes: "tone:beep",
		},
		{
			name:      "an inline tone spec",
			refs:      []string{"tone:1000/100"},
			wantLoop:  true,
			wantMs:    100,
			describes: "tone:1000/100",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			source, err := library.LoadSource(testCase.refs, audio.EncodingULaw)
			if err != nil {
				t.Fatalf("LoadSource(%v): %v", testCase.refs, err)
			}
			if source.Loop != testCase.wantLoop {
				t.Errorf("Loop = %v, want %v", source.Loop, testCase.wantLoop)
			}
			if got := source.Clip.DurationMs(); got != testCase.wantMs {
				t.Errorf("duration = %d ms, want %d", got, testCase.wantMs)
			}
			if source.Description != testCase.describes {
				t.Errorf("Description = %q, want %q", source.Description, testCase.describes)
			}
			if source.Clip.Encoding != audio.EncodingULaw {
				t.Errorf("Encoding = %v, want µ-law", source.Clip.Encoding)
			}
		})
	}
}

func TestLoadSourceRefusals(t *testing.T) {
	root := t.TempDir()
	writePrompt(t, root, "welcome.wav", 1)
	writePrompt(t, root, "moh/default.wav", 1)
	library := audio.NewLibrary(root)

	cases := []struct {
		name string
		refs []string
		want error
	}{
		{
			// A menu concatenated onto the end of an infinite loop is audio no caller ever reaches.
			name: "a tone mixed with a prompt",
			refs: []string{"tone:busy", "sound:welcome"},
			want: audio.ErrMixedSources,
		},
		{
			name: "a prompt mixed with hold music",
			refs: []string{"sound:welcome", "moh:default"},
			want: audio.ErrMixedSources,
		},
		{
			name: "two music classes",
			refs: []string{"moh:default", "moh:default"},
			want: audio.ErrMixedSources,
		},
		{
			name: "an unknown tone",
			refs: []string{"tone:trombone"},
			want: audio.ErrUnknownTone,
		},
		{
			name: "a music class that is not mounted",
			refs: []string{"moh:nosuchclass"},
			want: audio.ErrNotFound,
		},
		{
			// The class becomes a filename, so a separator in it is a traversal — the same rule a
			// recording reference follows for the same reason.
			name: "a music class with a path separator",
			refs: []string{"moh:../../etc/passwd"},
			want: audio.ErrOutsideLibrary,
		},
		{
			name: "a generator scheme mediad still has no synthesiser for",
			refs: []string{"digits:1234"},
			want: audio.ErrUnsupportedScheme,
		},
		{
			name: "nothing at all",
			refs: nil,
			want: audio.ErrNotFound,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := library.LoadSource(testCase.refs, audio.EncodingULaw)
			if !errors.Is(err, testCase.want) {
				t.Fatalf("LoadSource(%v) = %v, want %v", testCase.refs, err, testCase.want)
			}
		})
	}
}

func TestToneNeedsNoPromptLibrary(t *testing.T) {
	t.Parallel()

	// The point of generating tones rather than shipping them: an instance that has not mounted a
	// prompt store can still tell a caller the far end is ringing. Making ringback depend on a mount
	// would mean an instance that can bridge a call cannot report on it.
	library := audio.NewLibrary("")
	if library.Configured() {
		t.Fatal("Configured() is true with no root")
	}

	source, err := library.LoadSource([]string{"tone:ringback"}, audio.EncodingALaw)
	if err != nil {
		t.Fatalf("LoadSource: %v", err)
	}
	if !source.Loop {
		t.Error("ringback does not loop")
	}
	if source.Clip.Encoding != audio.EncodingALaw {
		t.Error("the tone was not generated in the leg's own law")
	}

	// Music on hold IS a file, so it still needs the mount — and says so.
	if _, err := library.LoadSource([]string{"moh:default"}, audio.EncodingULaw); !errors.Is(err, audio.ErrNoLibrary) {
		t.Fatalf("moh: without a library = %v, want ErrNoLibrary", err)
	}
}

func TestUnsupportedSchemeNamesWhatIsAvailable(t *testing.T) {
	t.Parallel()

	library := audio.NewLibrary(t.TempDir())
	_, err := library.LoadSource([]string{"characters:abc"}, audio.EncodingULaw)
	if err == nil {
		t.Fatal("LoadSource accepted a scheme mediad cannot serve")
	}
	for _, scheme := range []string{"sound:", "tone:", "moh:"} {
		if !strings.Contains(err.Error(), scheme) {
			t.Errorf("the refusal does not mention %q: %v", scheme, err)
		}
	}
}
