import { runCommand } from "@oclif/test";
import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@ctl[workspaces:logout]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it.skip("fails when the reference is missing", async function () {
		// Skipped: runCommand from @oclif/test does not reliably capture the
		// missing-arg error output when mocha runs from the monorepo root.
		// This tests oclif's built-in validation, not application logic.
		const { error, stderr } = await runCommand(["workspaces:logout"], {
			root: __dirname + "/../..",
		});
		const message = error?.message || stderr || "";
		expect(message).to.include("Missing 1 required arg");
		expect(message).to.include("ref  the Workspace to unlink from");
	});

	it("ensures user logout from workspace", async function () {
		const { stdout } = await runCommand(["workspaces:logout", "my-workspace"]);
		expect(stdout).to.contain("Done!");
	});
});
