export function parseLoginError(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		return (error as { message: string }).message;
	}

	return "Oops! Invalid email or password. Please try again.";
}
