import { useCallback, useEffect, useState } from "react";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useApplicationContext } from "../stores/application.store";
import { useSipTestCall } from "./use-sip";

/**
 * useApplicationTestCall
 *
 * @description
 * Hook that integrates SIP-based test call logic with application context.
 * It manages call state, disables the UI when testing is unavailable, and handles lifecycle behavior
 * such as automatic connection and cleanup.
 *
 * @returns
 * - `audioRef`: Reference to audio element for media playback.
 * - `isLoadingCall`: Flag to disable the test call button.
 * - `isCalling`: Boolean representing an active test call.
 * - `onTestCall()`: Function to initiate the test call (with auto-connect if needed).
 */
export const useApplicationTestCall = () => {
	/** Disable the test button temporarily to prevent double clicks. */
	const [isLoadingCall, setIsLoadingCall] = useState(false);

	/** Get current application reference from context. */
	const {
		application: { ref: appRef },
	} = useApplicationContext();

	/** SIP call control and state from internal hook. */
	const {
		audioRef,
		state: { isConnected, isCalling, isAnswered },
		connect,
		call,
		close,
	} = useSipTestCall();

	/**
	 * onTestCall
	 *
	 * @description
	 * Handles logic to initiate a SIP test call for the current application.
	 * Ensures the application is saved, then connects and calls.
	 */
	const onTestCall = useCallback(async () => {
		if (!appRef) {
			toast("Please complete the application and save it before testing.");
			return;
		}

		try {
			setIsLoadingCall(true);
			toast("Initiating test call...");

			// Ensure connection to SIP server before making a call
			if (!isConnected) await connect();

			await call(appRef);
		} catch (err) {
			toast(getErrorMessage(err));
		} finally {
			setIsLoadingCall(false);
		}
	}, [appRef, connect, call, isConnected]);

	/**
	 * Cleanup SIP session and disconnect audio stream when unmounting.
	 */
	useEffect(() => {
		return () => {
			close();
		};
	}, [close]);

	return {
		audioRef,
		isLoadingCall,
		isCalling,
		isAnswered,
		onTestCall,
		hangup: close,
	};
};
