import { useContext } from "react";
import { OptimiqVoiceContext } from "../stores/optimiq-voice.store";

/**
 * Internal hook used to access the OptimiqVoiceContext.
 *
 * Throws a descriptive error if used outside of the OptimiqVoiceProvider.
 *
 * @returns The current value of the Optimiq Voice context.
 */
const useOptimiqVoiceContext = () => {
  const context = useContext(OptimiqVoiceContext);

  if (!context) {
    throw new Error(
      "Oops! You need to be inside a <OptimiqVoiceProvider /> to use this hook."
    );
  }

  return context;
};

/**
 * Hook that provides access to the Optimiq Voice client and related context.
 *
 * Ensures that the client is available before returning the context,
 * making it safe to use SDK modules or perform client operations.
 *
 * @throws Error if the client is not initialized.
 * @returns An object containing the Optimiq Voice client, session state,
 *          authentication helpers, and SDK modules.
 */
export const useOptimiqVoice = () => {
  const { client, sdk, ...rest } = useOptimiqVoiceContext();

  if (!client || !sdk) {
    throw new Error(
      "Oops! The Optimiq Voice client is not available. Please check your configuration."
    );
  }

  return { client, sdk, ...rest };
};
