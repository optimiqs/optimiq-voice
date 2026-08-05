import sinon from "sinon";

function getExtendedFieldsHelper(sandbox: sinon.SinonSandbox) {
	return sandbox.stub().resolves({
		ref: "123",
		extended: {
			accessKeyId: "GRahn02s8tgdfghz72vb0fz538qpb5z35p",
		},
	});
}

export { getExtendedFieldsHelper };
