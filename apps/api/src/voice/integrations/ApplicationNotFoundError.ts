class ApplicationNotFoundError extends Error {
	constructor(appRef: string) {
		super(`Application not found: ${appRef}`);
		this.name = this.constructor.name;
	}
}

export { ApplicationNotFoundError };
