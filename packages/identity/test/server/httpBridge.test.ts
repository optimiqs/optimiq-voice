import { expect } from "chai";
import { IdentityConfig } from "../../src/exchanges/types";
import { startHttpBridge } from "../../src/server/httpBridge";

describe("@identity/httpBridge", function () {
	it("redirects an invalid invite to the configured failure URL", async function () {
		const failureUrl = "https://example.com/invite-failed";
		const app = await startHttpBridge({ workspaceInviteFailUrl: failureUrl } as IdentityConfig, {
			port: 0,
			appUrl: "https://example.com",
		});

		try {
			const response = await app.inject({
				method: "GET",
				url: "/api/identity/accept-invite",
			});

			expect(response.statusCode).to.equal(302);
			expect(response.headers.location).to.equal(failureUrl);
		} finally {
			await app.close();
		}
	});
});
