class MethodNotImplementedError extends Error {
	constructor() {
		super("Method not implemented! Use derived class");
	}
}

export { MethodNotImplementedError };
