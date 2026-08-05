import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Logger } from "~/core/shared/logger";
import { Splash } from "../splash/splash";

export const ErrorLayout = ({ errorCode }: { errorCode: number }) => {
	const navigate = useNavigate();

	useEffect(() => {
		Logger.error(`[ErrorBoundary]: An error occurred with code ${errorCode}`);

		const time = setTimeout(() => {
			Logger.debug("[ErrorBoundary]: Redirecting to home page");
			navigate("/");
		}, 10_000);

		return () => {
			clearTimeout(time);
		};
	}, []);

	return <Splash message="Loading Optimiq Voice Services... Please wait." />;
};
