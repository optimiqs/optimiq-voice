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
// # Why a mounted DIRECTORY and not an HTTP fetch from apps/api
//
// This was the open question rung 1 had to answer, and the repo had already answered it once. The
// engine's own resolver says so at length in apps/engine/src/routing/media-refs.ts: the only way
// audio in the object store becomes playable is for the store to be VISIBLE TO THE MEDIA SERVER AS
// A FILESYSTEM, and "inventing a fetch-and-stage step inside the engine would put a download on the
// call path". `MediaRefSettings.objectMediaRoot` is that mount for Asterisk. MEDIAD_SOUNDS_DIR is
// the same mount for mediad, which is what lets one prompt library serve both planes during a
// per-capability cutover — the same `sound:` string resolves on either.
//
// Fetching over HTTP from the API's streaming endpoint was the alternative and loses on three
// counts, in increasing order of seriousness:
//
//  1. It puts a network round trip, a TLS handshake and an object-store read inside `play`, which
//     is a 1 s command on a call path where the caller is listening to silence until it returns.
//  2. It gives mediad a control-plane credential. config/nats.conf spends a paragraph on the
//     opposite policy — "apps/mediad cannot read rpc.sip.v1.credential… the process with the widest
//     network exposure on the platform, since it terminates RTP from the internet" — and an API
//     token in this process would undo it for the same reason it was granted.
//  3. It makes the media plane a client of the control plane, which design doc §5 spends its whole
//     length keeping apart. mediad owns media. It does not hold database handles, it does not speak
//     SIP, and it should not speak HTTP to apps/api either.
//
// The cost, stated plainly: a deployment must mount the prompt store on every mediad host, and a
// prompt uploaded through the API is playable only once that mount sees it. That is an operational
// dependency, and it is the same one Asterisk already has.
//
// A caching layer in front of the reads is deliberately NOT here. It is the obvious next step and
// it is a decision with its own invalidation question attached, and rung 1's job is to make a
// prompt play at all.
type Library struct {
	root string
}

var (
	// ErrNoLibrary means MEDIAD_SOUNDS_DIR is unset, so this instance has no prompts to play.
	//
	// A refusal, not an empty playback. An instance configured without a library must say so on
	// every play — the engine reads it as `not_supported` and routes the leg to Asterisk — rather
	// than answering `ok` and sending nothing, which is a caller hearing silence where a menu was.
	ErrNoLibrary = errors.New("audio: no prompt library is configured")
	// ErrUnsupportedScheme means a media ref mediad has no way to serve.
	ErrUnsupportedScheme = errors.New("audio: unsupported media scheme")
	// ErrOutsideLibrary means a resolved path escaped the configured root.
	ErrOutsideLibrary = errors.New("audio: the media reference escapes the prompt library")
	// ErrNotFound means the reference resolved to a path with no file at it.
	ErrNotFound = errors.New("audio: no such prompt")
	// ErrMixedSources means a request combined a LOOPING reference with something else.
	//
	// Its own sentinel because it is the one refusal on this path that is about the REQUEST rather
	// than about a file: concatenating a menu prompt onto the end of a music-on-hold loop produces
	// a prompt nobody ever reaches, and concatenating one onto a ringback cadence produces a
	// cadence with a sentence inside it. Both are the caller having asked for something that cannot
	// mean anything, so both are refused by name rather than served in whichever order they arrived.
	ErrMixedSources = errors.New("audio: a looping reference cannot be concatenated with another")
)

// The media schemes this build resolves, beyond `sound:`.
const (
	// SchemeSound is a file in the prompt library. What every engine `MediaRef` renders into.
	SchemeSound = "sound:"
	// SchemeTone is a generated call-progress tone. See tone.go.
	SchemeTone = "tone:"
	// SchemeMOH is a music-on-hold class: a looping file under `<root>/moh/`.
	//
	// A SCHEME rather than a `sound:` path with a loop flag, because the thing being named is a
	// deployment's hold music by CLASS — the same vocabulary ARI's `channels.startMoh(mohClass)`
	// uses — and the mapping from a class to a file is the media plane's business. An engine that
	// had to know the layout would be a second source of truth about this instance's disk.
	SchemeMOH = "moh:"
)

// DefaultMOHClass is the class a `moh:` reference with no name resolves to, matching Asterisk's own
// `default` music class so one engine-side setting serves both planes during the cutover.
const DefaultMOHClass = "default"

// mohDirectory is the subdirectory of the prompt library hold music lives in.
//
// A convention rather than a second environment variable. MEDIAD_SOUNDS_DIR is already the mount a
// deployment shares with Asterisk, hold music is prompt audio, and a second mount to configure would
// be a second thing to get wrong for no capability anybody gains.
const mohDirectory = "moh"

// Source is what a playback request resolved to: the audio, and whether it repeats.
//
// The loop flag lives HERE rather than on the wire because it is a property of what was ASKED FOR
// rather than of how the caller wants it played. `moh:` is hold music and hold music repeats; a
// ringback cadence repeats because ringing persists; a prompt and a beep do not. A caller that could
// set the flag independently could ask for a looping voicemail greeting, which is a call nobody can
// end.
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

// LoadAll resolves several references and concatenates them into one clip.
//
// `PlayRequest.media` is a LIST because ARI's is, and ARI plays it in sequence. Concatenating the
// frames produces the same audio with none of the state a playback queue would need — and, more to
// the point, none of the gap: a queue that started the next file after the previous one drained
// would put a scheduling delay between "your call is important" and "to us".
//
// One unresolvable element fails the WHOLE request. Skipping it would play half a sentence, and a
// prompt missing its middle clause is worse than a leg the engine routes to Asterisk instead.
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

// LoadSource resolves a whole playback request, which is where the three schemes are told apart.
//
// # Why the schemes cannot be mixed
//
// A LOOPING source has no end, so anything concatenated after it is audio no caller ever reaches.
// Rather than silently dropping the tail — or, worse, playing a menu once at the top of an infinite
// hold loop — a request that combines one with anything else is refused naming both. `sound:` refs
// concatenate with each other exactly as they always have, because that is ARI's own behaviour and
// what a multi-clause prompt needs.
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

// loadMOH resolves a music-on-hold class to a looping clip.
//
// The class maps to `<root>/moh/<class>.wav` and nothing cleverer. A DIRECTORY of clips played in
// sequence — which is what Asterisk's `moh` classes are — is deliberately not built here: it needs a
// shuffle policy, a per-session position and a decision about what happens when the directory
// changes under a live call, and none of those is a decision this rung has to make in order for a
// held caller to hear music. Naming the single-file form as the shape means adding the directory
// form later is additive rather than a change to what a class MEANS.
func (l *Library) loadMOH(class string, encoding Encoding) (*Source, error) {
	name := strings.TrimSpace(class)
	if name == "" {
		name = DefaultMOHClass
	}
	// A class is one path element, always. It becomes a filename, so a separator in it is a
	// traversal and a dot-segment is one with extra steps — refused for exactly the reason a
	// recording reference is.
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return nil, fmt.Errorf("%w: a music class is one name, got %q", ErrOutsideLibrary, class)
	}

	clip, err := l.Load(SchemeSound+mohDirectory+"/"+name, encoding)
	if err != nil {
		return nil, err
	}
	return &Source{Clip: clip, Loop: true, Description: SchemeMOH + name}, nil
}

// Resolve turns a media reference into an absolute path inside the library.
//
// # Which schemes resolve, and why the rest are refused BY NAME
//
// `sound:` only, because `sound:` is the only thing apps/engine/src/routing/media-refs.ts ever
// emits: every domain `MediaRef` — `prompt://`, `file://`, `object://` — is rendered into it, and
// the ones that are not (`tts://`, `stream://`, `https://`) resolve to `undefined` in the engine and
// never reach a media plane at all.
//
// The refused set is therefore Asterisk's GENERATORS: `tone:`, `digits:`, `number:`,
// `characters:`. Those are not files, they are a synthesiser mediad does not have, and each one is
// refused with its own name in the message so an operator reading a failed call knows the prompt
// was not missing — the capability was.
//
// # Traversal
//
// `..` is rejected outright rather than normalised, and the resolved path is re-checked against the
// root afterwards. media-refs.ts makes the same check for the same reason: the key comes out of a
// compiled artifact, which comes out of a database row, which comes out of an upload, and a
// reference of `../../etc/shadow` that this function helpfully resolved would be a tenant reading a
// file off the media host by naming a voicemail greeting.
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
		// scheme at this point is one of Asterisk's remaining generators (`digits:`, `number:`,
		// `characters:`), which are a text-to-speech problem wearing a media reference's clothes.
		return "", fmt.Errorf(
			"%w: %q is a generator scheme mediad has no synthesiser for; it resolves sound:, tone: and moh:",
			ErrUnsupportedScheme, scheme+":")
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: sound: with no path", ErrNotFound)
	}
	for _, element := range strings.Split(filepath.ToSlash(name), "/") {
		if element == ".." {
			return "", fmt.Errorf("%w: %q", ErrOutsideLibrary, ref)
		}
	}

	// The engine strips a file extension on the way out (media-refs.ts: "Asterisk picks the best
	// available format itself"), so a reference usually arrives without one. mediad has exactly one
	// container, so it appends the one it can read rather than probing a format list it does not
	// have.
	if filepath.Ext(name) == "" {
		name += ".wav"
	}

	root := filepath.Clean(l.root)
	// An ABSOLUTE reference is accepted when it is already inside the root, because that is what a
	// deployment sharing one mount with Asterisk produces: `objectMediaRoot` renders absolute paths
	// and the same string has to resolve on both planes.
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
