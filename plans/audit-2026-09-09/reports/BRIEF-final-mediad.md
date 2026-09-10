# Shared brief for the final mediad sweep

Read first (absolute paths):

- /private/tmp/claude-501/-Users-jayarajsrivathsavadari-Documents-Github-fonoster/d22c2238-f57c-44f4-832e-7d32567ef763/scratchpad/audit/COMMENT_POLICY.md
- /private/tmp/claude-501/-Users-jayarajsrivathsavadari-Documents-Github-fonoster/d22c2238-f57c-44f4-832e-7d32567ef763/scratchpad/audit/MODERN_GO.md

Two passes over YOUR assigned files only. Touch nothing outside them.

## Pass 1 — comment sweep (COMMENT-ONLY)

Apply COMMENT_POLICY.md. No code edits at all in this pass. Verify each edited file with
`git diff -U0 -w -- <file>` and confirm zero non-comment lines changed.
If a comment is factually WRONG (contradicts the code), correct the comment — do not change the code;
note it in your report.
Record `grep -cE '^\s*//' <file>` before and after for every file in your scope (including files you
end up not changing).

## Pass 2 — modern Go

Guidelines list for this workspace (go 1.26) is identical for every file; the CLI `list` just prints it.
Apply, wherever it fits YOUR files:

- slices.Clone for `append([]T(nil), s...)` / `append([]T{}, s...)` clone idiom
  EXCEPTION: if a nil result must marshal as `[]` on the wire (JSON), keep the append form and say so.
- range_over_int: `for i := 0; i < n; i++` -> `for i := range n`, ONLY when n is a loop-invariant
  expression (do not convert when the bound is re-evaluated per iteration and could change).
- testing_t_context: `context.WithTimeout(context.Background(), ...)` in tests -> parent from `t.Context()`
  (`b.Context()` in benchmarks).
- strings.SplitSeq / strings.FieldsSeq when the split result is only ranged over.
- errors.Is instead of `err == target`; errors.AsType[T](err) instead of `var e *T; errors.As(err, &e)`.
- built-in min/max instead of handwritten if-comparisons.
- clear(m) / clear(s) instead of manual zeroing loops.
- testing_b_loop (`for b.Loop()`), sync_waitgroup_go (`wg.Go`), atomic typed atomics, `any` over
  `interface{}`, cmp.Or, time.Since/time.Until, bytes.Clone/strings.Clone, slices.Contains/Index/Sort,
  maps.Clone/Copy/DeleteFunc, fmt.Appendf, sync.OnceValue/OnceFunc.
  Must be BEHAVIOUR-NEUTRAL. Existing tests must pass unchanged — do not edit a test's assertions to
  make a change fit. Skip anything that would change semantics and say why.

## Verify (your package only)

cd /Users/jayarajsrivathsavadari/Documents/Github/fonoster/apps/mediad
gofmt -l . ; go vet ./<yourpkg>/... ; go test -race ./<yourpkg>/...
Do NOT run `go test ./...` (parallel packages collide on UDP ports) and do NOT commit or touch git state.

## Report back (text only, no files)

- per-file comment counts before/after
- guidelines applied, per file/line
- guidelines deliberately skipped + why
- wrong comments corrected
- verification output
