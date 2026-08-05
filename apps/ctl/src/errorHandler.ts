function errorHandler(e: unknown, log: (message: string) => void): void {
	const error = e as { code?: number; message: string };
	if (error.code === 3) {
		const splitPoint = "3 INVALID_ARGUMENT:";
		const message = error.message.split(splitPoint);
		log(message[1]);
		return;
	}
	log?.(error.message.trim());
}

export default errorHandler;
