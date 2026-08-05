import { useContext } from "react";
import { AuthenticatedContext } from "../stores/authenticated.store";

/**
 * Custom hook to access the authentication context.
 * Throws an error if used outside of an <AuthenticatedProvider />.
 *
 * @returns The current authentication context value.
 */
const useAuthContext = () => {
  const context = useContext(AuthenticatedContext);

  if (!context) {
    throw new Error(
      "Oops! You need to be inside an <AuthenticatedProvider /> to use this hook."
    );
  }

  return context;
};

/**
 * Custom hook to access authenticated user data.
 * Ensures the user is authenticated before usage.
 * Throws an error if the user is not authenticated.
 *
 * @returns An object containing the authenticated user and additional context.
 */
export const useAuth = () => {
  const { user, ...rest } = useAuthContext();

  if (!user) {
    throw new Error("Oops! You need to be authenticated to use this hook.");
  }

  return { user, ...rest };
};
