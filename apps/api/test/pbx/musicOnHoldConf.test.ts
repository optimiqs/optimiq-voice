import { expect } from "chai";
import { mohClassDirectory, renderMusicOnHoldConf } from "../../src/pbx/media/musiconhold-conf";
import type { MohClassRow } from "../../src/pbx/media/musiconhold-conf";

/**
 * The `musiconhold.conf` renderer.
 *
 * Golden-ish rather than a byte-for-byte fixture, on the same terms `test/provisioning/
 * provisioningCatalog.test.ts` states for the phone templates: the assertions pin the lines a call
 * cannot work without — the section header the engine asks for by name, the `directory=` the media
 * server opens, the sort order — and deliberately do not pin the whole document, so adding a
 * comment line is an ordinary edit rather than a fixture rewrite nobody reads.
 *
 * The one thing pinned exactly is the PATH, because it is the only value in the file that can be
 * plausibly wrong: the API and the media server see the same directory at two paths, and a
 * `directory=` carrying the API's would produce a file that parses perfectly and plays silence.
 */

const ORG_A = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const ORG_B = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const CLASS_A = "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6";
const CLASS_B = "019fd3c2-bbbb-76be-a6b3-b0f1914e39b6";
const CONTAINER_ROOT = "/var/lib/optimiq/objects";

function mohRow(overrides: Partial<MohClassRow> = {}): MohClassRow {
	return {
		id: CLASS_A,
		organizationId: ORG_A,
		name: "jazz",
		source: "library",
		streamUri: null,
		shuffle: true,
		sampleRateHz: 8000,
		enabled: true,
		fileCount: 3,
		...overrides,
	};
}

function render(rows: readonly MohClassRow[]) {
	return renderMusicOnHoldConf(rows, {
		containerObjectRoot: CONTAINER_ROOT,
		generatedAt: "2026-08-06T09:00:00.000Z",
	});
}

describe("renderMusicOnHoldConf", () => {
	it("always declares [default] so an unknown class falls back to audio rather than silence", () => {
		const result = render([]);
		expect(result.body).to.contain("[default]");
		expect(result.body).to.contain("directory=/usr/share/asterisk/moh");
		expect(result.declared).to.deep.equal([]);
	});

	it("says at the top that it is generated, and how to apply it", () => {
		const result = render([mohRow()]);
		expect(result.body).to.contain("GENERATED FILE");
		expect(result.body).to.contain("generate:musiconhold");
		expect(result.body).to.contain("module reload res_musiconhold.so");
	});

	/**
	 * The whole point of the file. The section name is what `apps/engine` puts in
	 * `POST /channels/{id}/moh?mohClass=…`, having got it from the compiler, having got it from
	 * `moh_class.name` — so a section named anything else is a class that does not resolve.
	 */
	it("declares a library class under its own name, pointing at the container's path", () => {
		const result = render([mohRow()]);
		expect(result.body).to.contain("[jazz]");
		expect(result.body).to.contain("mode=files");
		expect(result.body).to.contain(`directory=/var/lib/optimiq/objects/moh/${ORG_A}/${CLASS_A}`);
		expect(result.declared).to.deep.equal(["jazz"]);
	});

	it("derives the directory from the storage layout rather than a second hard-coded prefix", () => {
		expect(mohClassDirectory(CONTAINER_ROOT, mohRow())).to.equal(
			`/var/lib/optimiq/objects/moh/${ORG_A}/${CLASS_A}`,
		);
		// A trailing slash on the mount point must not produce a doubled separator: Asterisk opens the
		// string verbatim.
		expect(mohClassDirectory("/var/lib/optimiq/objects/", mohRow())).to.equal(
			`/var/lib/optimiq/objects/moh/${ORG_A}/${CLASS_A}`,
		);
	});

	it("spells shuffle as Asterisk does, and orders the rest the way the UI lists them", () => {
		expect(render([mohRow({ shuffle: true })]).body).to.contain("sort=random");
		expect(render([mohRow({ shuffle: false })]).body).to.contain("sort=alpha");
	});

	it("renders a stream class as mode=custom and never as a directory", () => {
		const result = render([
			mohRow({ source: "stream", streamUri: "http://radio.example/stream", fileCount: 0 }),
		]);
		expect(result.body).to.contain("mode=custom");
		expect(result.body).to.contain("application=/usr/bin/mpg123");
		expect(result.body).to.not.contain("mode=files\ndirectory=/var/lib/optimiq/objects/moh");
		expect(result.declared).to.deep.equal(["jazz"]);
	});

	/**
	 * `mode=files` over an empty directory is Asterisk's worst failure here: one "cannot open dir"
	 * at load and silence for the life of the process. An undeclared class falls back to `default`,
	 * which has audio in it.
	 */
	it("leaves a class with no files undeclared rather than pointing at an empty directory", () => {
		const result = render([mohRow({ fileCount: 0 })]);
		expect(result.declared).to.deep.equal([]);
		expect(result.skipped).to.deep.equal([
			{ id: CLASS_A, organizationId: ORG_A, name: "jazz", reason: "no-files" },
		]);
	});

	/** The compiler warns that a disabled class falls back to the default; the file must agree. */
	it("leaves a disabled class undeclared, matching the compiler's warning", () => {
		const result = render([mohRow({ enabled: false })]);
		expect(result.declared).to.deep.equal([]);
		expect(result.skipped[0]?.reason).to.equal("disabled");
	});

	it("refuses a stream class with no URI rather than emitting a section that hangs the channel", () => {
		const result = render([mohRow({ source: "stream", streamUri: "  ", fileCount: 0 })]);
		expect(result.declared).to.deep.equal([]);
		expect(result.skipped[0]?.reason).to.equal("stream-without-uri");
	});

	/**
	 * The cross-tenant leak this file has to refuse.
	 *
	 * `moh_class.name` is unique per ORGANIZATION; Asterisk's class namespace is global. Picking a
	 * winner would play one tenant's hold music to another tenant's callers. Neither is declared,
	 * both are reported, and the callers fall back to `default` — which is exactly what happens
	 * today, so nothing regresses while the ambiguity stands.
	 */
	it("declares neither side of a name two organizations claim, and reports both", () => {
		const result = render([
			mohRow({ id: CLASS_A, organizationId: ORG_A, name: "hold" }),
			mohRow({ id: CLASS_B, organizationId: ORG_B, name: "hold" }),
		]);
		expect(result.declared).to.deep.equal([]);
		expect(result.body).to.not.contain("[hold]");
		expect(result.conflicts).to.deep.equal([
			{ name: "hold", organizationIds: [ORG_A, ORG_B].sort() },
		]);
		expect(result.skipped.map((entry) => entry.reason)).to.deep.equal([
			"name-conflict",
			"name-conflict",
		]);
		// The banner has to name it, because the generator's stderr scrolls away and this file does
		// not.
		expect(result.body).to.contain("NOT DECLARED");
		expect(result.body).to.contain("hold");
	});

	it("treats a tenant class named `default` as a conflict with the media server's fallback", () => {
		const result = render([mohRow({ name: "default" })]);
		expect(result.declared).to.deep.equal([]);
		expect(result.conflicts[0]?.name).to.equal("default");
		// One [default] section, and it is the built-in one.
		expect(result.body.match(/^\[default\]$/gmu)?.length).to.equal(1);
		expect(result.body).to.contain("directory=/usr/share/asterisk/moh");
	});

	/**
	 * Two runs over an unchanged database must be byte-identical, or "did the hold music change?"
	 * becomes a question only a checksum of the whole database can answer — and a deployment that
	 * diffs the generated file to decide whether to reload gets a reload on every run.
	 */
	it("is stable under input order, so an unchanged database renders an unchanged file", () => {
		const first = mohRow({ id: CLASS_A, name: "alpha" });
		const second = mohRow({ id: CLASS_B, name: "beta" });
		expect(render([first, second]).body).to.equal(render([second, first]).body);
	});
});
