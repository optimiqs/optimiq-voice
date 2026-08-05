import { createContext, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import { Splash } from "~/core/components/general/splash/splash";
import { Logger } from "~/core/shared/logger";
import { useWorkspaces } from "~/workspaces/services/workspaces.service";
import { useAuthenticatedClient } from "../hooks/use-authenticated-client";
import { useCurrentUser } from "../hooks/use-current-user";
import type {
	AuthenticatedContextValue,
	AuthenticatedProviderProps,
} from "./authenticated.interfaces";
import type { Workspace } from "@optimiq-voice/types";

/**
 * Context to provide authenticated user and workspace data
 * to the entire application.
 */
export const AuthenticatedContext = createContext<AuthenticatedContextValue | null>(null);

/**
 * Provider component that manages the authenticated user,
 * current workspace, and relevant state for the authenticated context.
 *
 * @param {AuthenticatedProviderProps} props - The props containing children to render.
 * @returns {JSX.Element} The provider wrapping its children.
 */
export const AuthenticatedProvider = ({ children, initialSession }: AuthenticatedProviderProps) => {
	/** Retrieve the Optimiq Voice client instance */
	const client = useAuthenticatedClient(initialSession);

	/** Extract the workspaceId from the URL parameters */
	const { workspaceId } = useParams<{ workspaceId: string }>();

	/** Custom hook to retrieve the current authenticated user */
	const { user, setUser, isLoading: isUserLoading } = useCurrentUser();

	/** Fetch all workspaces the user has access to */
	const { data: workspaces = [], isLoading: isWorkspacesLoading } = useWorkspaces();

	/** State to track the currently selected workspace */
	const [currentWorkspace, setCurrentWorkspace] = useState<Workspace | null>(null);

	/**
	 * Callback to handle workspace changes by updating the current workspace
	 * and setting the corresponding access key ID in the Optimiq Voice client.
	 *
	 * @param {string} workspaceId - The ID of the workspace to switch to.
	 */
	const onWorkspaceChange = useCallback(
		(workspaceId: string) => {
			const workspace = workspaces.find((w) => w.ref === workspaceId);

			if (workspace) {
				setCurrentWorkspace(workspace);

				if (workspace.accessKeyId) {
					client.setAccessKeyId(workspace.accessKeyId);
				}
			} else {
				Logger.debug(`[<AuthenticatedProvider />] Workspace with ID ${workspaceId} not found.`);
			}
		},
		[workspaces, client],
	);

	/**
	 * Memoized object representing the authenticated session state.
	 * This prevents unnecessary re-renders of consumers when values haven't changed.
	 */
	const session = useMemo<AuthenticatedContextValue>(
		() => ({
			user,
			setUser,
			workspaces,
			currentWorkspace,
			setCurrentWorkspace,
			onWorkspaceChange,
		}),
		[user, setUser, workspaces, currentWorkspace, setCurrentWorkspace, onWorkspaceChange],
	);

	/**
	 * Effect to automatically update the current workspace
	 * whenever the workspaceId param changes.
	 */
	useEffect(() => {
		if (workspaceId) {
			onWorkspaceChange(workspaceId);
		}
	}, [workspaceId, onWorkspaceChange]);

	/**
	 * Display a loading splash while user or workspace data is loading
	 * or if the user is not yet authenticated.
	 */
	if (isUserLoading || isWorkspacesLoading || !user) {
		return <Splash message="Who are you? Please wait..." />;
	}

	/**
	 * Provide the authenticated session context to children components.
	 */
	return <AuthenticatedContext.Provider value={session}>{children}</AuthenticatedContext.Provider>;
};
