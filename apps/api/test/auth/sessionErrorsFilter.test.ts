import { expect } from "chai";
import { MissingActiveOrganizationError, UnauthenticatedSessionError } from "@optimiq-voice/auth";
import { SessionErrorsFilter } from "../../src/auth/session-errors.filter";
import type { ArgumentsHost } from "@nestjs/common";

function hostRecording(): { host: ArgumentsHost; sent: { status?: number; body?: unknown } } {
	const sent: { status?: number; body?: unknown } = {};
	const reply = {
		status(code: number) {
			sent.status = code;
			return reply;
		},
		send(body: unknown) {
			sent.body = body;
			return Promise.resolve(reply);
		},
	};
	const host = {
		switchToHttp: () => ({ getResponse: () => reply }),
	} as unknown as ArgumentsHost;
	return { host, sent };
}

describe("SessionErrorsFilter", () => {
	it("answers a missing active organization with the guard's 403", () => {
		const { host, sent } = hostRecording();
		new SessionErrorsFilter().catch(new MissingActiveOrganizationError("user-1"), host);
		expect(sent.status).to.equal(403);
		expect(sent.body).to.include({ statusCode: 403 });
		expect(String((sent.body as { message: string }).message)).to.match(/no active organization/i);
	});

	it("answers an unauthenticated session with the guard's 401", () => {
		const { host, sent } = hostRecording();
		new SessionErrorsFilter().catch(new UnauthenticatedSessionError(), host);
		expect(sent.status).to.equal(401);
		expect(sent.body).to.include({ statusCode: 401 });
	});
});
