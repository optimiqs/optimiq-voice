package audio

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Library resolves the media references the engine sends into files on this instance's disk.
//
// Prompts are read from a mounted DIRECTORY (MEDIAD_SOUNDS_DIR), not fetched over HTTP from
// apps/api: fetching would put a network round trip inside `play`, would need a control-plane
// credential this process is deliberately denied (config/nats.conf), and would make the media plane
// a client of the control plane. It is the same mount Asterisk resolves `objectMediaRoot` against,
// so one `sound:` string works on either plane. The cost is that a prompt is playable only once the
// mount sees it. Reads are not cached.
type Library struct {
	root string
}

var (
	// ErrNoLibrary means MEDIAD_SOUNDS_DIR is unset, so this instance has no prompts to play. A
	// refusal, not an empty playback: the engine reads it as `not_supported` and routes the leg to
	// Asterisk.
	ErrNoLibrary = errors.New("audio: no prompt library is configured")
	// ErrUnsupportedScheme means a media ref mediad has no way to serve.
	ErrUnsupportedScheme = errors.New("audio: unsupported media scheme")
	// ErrOutsideLibrary means a resolved path escaped the configured root.
	ErrOutsideLibrary = errors.New("audio: the media reference escapes the prompt library")
	// ErrNotFound means the reference resolved to a path with no file at it.
	ErrNotFound = errors.New("audio: no such prompt")
	// ErrMixedSources means a request combined a LOOPING reference with something else, which would
	// produce audio nobody ever reaches.
	ErrMixedSources = errors.New("audio: a looping reference cannot be concatenated with another")
)

// The media schemes this build resolves, beyond `sound:`.
const (
	// SchemeSound is a file in the prompt library. What every engine `MediaRef` renders into.
	SchemeSound = "sound:"
	// SchemeTone is a generated call-progress tone. See tone.go.
	SchemeTone = "tone:"
	// SchemeMOH is a music-on-hold CLASS — ARI's `channels.startMoh(mohClass)` vocabulary —
	// resolving to a looping file under `<root>/moh/`. The class-to-file mapping stays in the media
	// plane so the engine is not a second source of truth about this instance's disk.
	SchemeMOH = "moh:"
)

// DefaultMOHClass is the class a `moh:` reference with no name resolves to, matching Asterisk's own
// `default` music class so one engine-side setting serves both planes during the cutover.
const DefaultMOHClass = "default"

// mohDirectory is the subdirectory of the prompt library hold music lives in. A convention rather
// than a second environment variable to configure.
const mohDirectory = "moh"

// Source is what a playback request resolved to: the audio, and whether it repeats. The loop flag
// is derived from the reference rather than set on the wire, so no caller can ask for a looping
// voicemail greeting.
type Source struct {
	Clip *Clip
	Loop bool
	// Description names what was resolved, for the log line on a hold that started music.
	Description string
}

// NewLibrary roots a library at a directory. An empty root is legal and refuses every load, which
// is the state of a deployment that has not mounted a prompt store yet.
func NewLibrary(root string) *Library {
	return &Library{root: strings.TrimSpace(root)}
}

// Configured reports whether this instance can serve prompts at all.
func (l *Library) Configured() bool { return l.root != "" }

// Root is the directory prompts are resolved under, for a log line and a refusal message.
func (l *Library) Root() string { return l.root }

// Load resolves one media reference, reads it and decodes it into the leg's companding law.
func (l *Library) Load(ref string, encoding Encoding) (*Clip, error) {
	path, err := l.Resolve(ref)
	if err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(path) //nolint:gosec // Resolve confines the path to the library root.
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrNotFound, ref)
		}
		return nil, fmt.Errorf("audio: reading %s: %w", ref, err)
	}
	clip, err := DecodeWAV(raw, encoding)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", ref, err)
	}
	return clip, nil
}

// LoadAll resolves several references and concatenates them into one clip. Concatenating frames
// rather than queueing files avoids a scheduling gap mid-sentence. One unresolvable element fails
// the whole request rather than playing a prompt with a clause missing.
func (l *Library) LoadAll(refs []string, encoding Encoding) (*Clip, error) {
	if len(refs) == 0 {
		return nil, fmt.Errorf("%w: a playback needs at least one media reference", ErrNotFound)
	}

	combined := &Clip{Encoding: encoding}
	for _, ref := range refs {
		clip, err := l.Load(ref, encoding)
		if err != nil {
			return nil, err
		}
		combined.Frames = append(combined.Frames, clip.Frames...)
	}
	return combined, nil
}

// LoadSource resolves a whole playback request, telling the three schemes apart. A looping source
// has no end, so combining one with any other reference is refused naming both; `sound:` refs
// concatenate with each other, as ARI does.
func (l *Library) LoadSource(refs []string, encoding Encoding) (*Source, error) {
	if len(refs) == 0 {
		return nil, fmt.Errorf("%w: a playback needs at least one media reference", ErrNotFound)
	}

	for _, ref := range refs {
		trimmed := strings.TrimSpace(ref)
		switch {
		case strings.HasPrefix(trimmed, SchemeTone):
			if len(refs) != 1 {
				return nil, fmt.Errorf("%w: %q is a tone and %d references were given",
					ErrMixedSources, trimmed, len(refs))
			}
			tone, err := ParseTone(strings.TrimPrefix(trimmed, SchemeTone))
			if err != nil {
				return nil, err
			}
			clip, err := tone.Generate(encoding)
			if err != nil {
				return nil, err
			}
			return &Source{Clip: clip, Loop: tone.Loop, Description: SchemeTone + tone.Name}, nil

		case strings.HasPrefix(trimmed, SchemeMOH):
			if len(refs) != 1 {
				return nil, fmt.Errorf("%w: %q is music on hold and %d references were given",
					ErrMixedSources, trimmed, len(refs))
			}
			return l.loadMOH(strings.TrimPrefix(trimmed, SchemeMOH), encoding)
		}
	}

	clip, err := l.LoadAll(refs, encoding)
	if err != nil {
		return nil, err
	}
	return &Source{Clip: clip, Loop: false, Description: strings.Join(refs, "+")}, nil
}

// loadMOH resolves a music-on-hold class to a looping clip at `<root>/moh/<class>.wav`. The
// directory-of-clips form Asterisk supports is not implemented; adding it later is additive.
func (l *Library) loadMOH(class string, encoding Encoding) (*Source, error) {
	name := strings.TrimSpace(class)
	if name == "" {
		name = DefaultMOHClass
	}
	// A class is one path element: it becomes a filename, so a separator or dot-segment is a
	// traversal attempt.
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return nil, fmt.Errorf("%w: a music class is one name, got %q", ErrOutsideLibrary, class)
	}

	clip, err := l.Load(SchemeSound+mohDirectory+"/"+name, encoding)
	if err != nil {
		return nil, err
	}
	return &Source{Clip: clip, Loop: true, Description: SchemeMOH + name}, nil
}

// Resolve turns a `sound:` media reference into an absolute path inside the library. `sound:` is
// the only scheme apps/engine/src/routing/media-refs.ts emits for a file; Asterisk's generator
// schemes (`digits:`, `number:`, `characters:`) are refused by name so an operator can tell a
// missing prompt from a missing capability.
//
// Security: `..` is rejected outright rather than normalised and the resolved path is re-checked
// against the root, because the reference ultimately originates from a tenant upload.
func (l *Library) Resolve(ref string) (string, error) {
	if l.root == "" {
		return "", fmt.Errorf("%w: set MEDIAD_SOUNDS_DIR to the directory prompts are mounted at",
			ErrNoLibrary)
	}

	trimmed := strings.TrimSpace(ref)
	name, found := strings.CutPrefix(trimmed, SchemeSound)
	if !found {
		scheme, _, hasScheme := strings.Cut(trimmed, ":")
		if !hasScheme {
			return "", fmt.Errorf("%w: %q names no scheme; mediad resolves sound:, tone: and moh:",
				ErrUnsupportedScheme, trimmed)
		}
		// `tone:` and `moh:` never reach here — LoadSource takes them first — so anything with a
		// scheme at this point is one of Asterisk's remaining generators.
		return "", fmt.Errorf(
			"%w: %q is a generator scheme mediad has no synthesiser for; it resolves sound:, tone: and moh:",
			ErrUnsupportedScheme, scheme+":")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: sound: with no path", ErrNotFound)
	}
	for element := range strings.SplitSeq(filepath.ToSlash(name), "/") {
		if element == ".." {
			return "", fmt.Errorf("%w: %q", ErrOutsideLibrary, ref)
		}
	}

	// The engine strips a file extension on the way out, so a reference usually arrives without
	// one. mediad reads exactly one container, so it appends that rather than probing.
	if filepath.Ext(name) == "" {
		name += ".wav"
	}

	root := filepath.Clean(l.root)
	// An absolute reference is accepted when already inside the root: `objectMediaRoot` renders
	// absolute paths and the same string has to resolve on both planes.
	var resolved string
	if filepath.IsAbs(name) {
		resolved = filepath.Clean(name)
	} else {
		resolved = filepath.Join(root, name)
	}

	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: %q resolves outside %s", ErrOutsideLibrary, ref, root)
	}
	return resolved, nil
}
