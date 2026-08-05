import { Box } from "@mui/material";
import { useCallback, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { FormSubmitButton } from "~/core/components/design-system/ui/form-submit-button/form-submit-button";
import { toast } from "~/core/components/design-system/ui/toaster/toaster";
import { Page } from "~/core/components/general/page/page";
import { PageHeader } from "~/core/components/general/page/page-header";
import { Splash } from "~/core/components/general/splash/splash";
import { FormProvider } from "~/core/contexts/form-context";
import { getErrorMessage } from "~/core/helpers/extract-error-message";
import { useCredential, useUpdateCredential } from "~/credentials/services/credentials.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { CreateCredentialForm } from "../create-credential/create-credential.form";
import type { Schema } from "../create-credential/create-credential.schema";
import type { Route } from "./+types/edit-credential.page";

/**
 * Sets the metadata for the "Edit Credential" page.
 *
 * This information is used by the router to define the page title and description
 * for SEO and display in the browser.
 *
 * @param _ - Meta arguments provided by the router (unused here).
 * @returns {Array} Metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Credentials | Optimiq Voice" },
		{
			name: "description",
			content: "Credentials are used to authenticate SIP Agents and Trunks within your network.",
		},
	];
}

/**
 * EditCredential page component.
 *
 * Renders a page to edit an existing voice credential, including:
 * - Page header with back navigation and save button.
 * - A form pre-filled with the credential details.
 * - Data fetching and optimistic update integration.
 *
 * @returns {JSX.Element} The rendered Edit Credential page.
 */
export default function EditCredential() {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Extracts the credential reference from the URL parameters. */
	const { ref } = useParams();

	/**
	 * Ensures the credential reference is provided.
	 *
	 * This value should never be null or undefined, as it is required
	 * to fetch and update the credential data.
	 */
	if (!ref) {
		throw new Error("Credential reference is required");
	}

	/** Fetches the existing credential details for editing. */
	const { data, isLoading } = useCredential(ref);

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the credentials page.
	 * Uses `viewTransition` for smoother transitions.
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/credentials`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to handle credential updates via the API. */
	const { mutate } = useUpdateCredential();

	/**
	 * Handler called after form submission.
	 * Updates the credential, shows a toast, and navigates back to the credentials page.
	 *
	 * @param {Schema} data - The validated form data.
	 */
	const onSave = useCallback(
		async ({ name }: Schema) => {
			try {
				mutate({ name, ref });
				toast("Credential updated successfully!");
				onGoBack();
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutate, ref, onGoBack],
	);

	/**
	 * Effect that ensures the user is redirected if the credential does not exist.
	 * Shows an error toast and navigates back to the credentials page.
	 */
	useEffect(() => {
		if (!isLoading && !data) {
			toast("Oops! You are trying to edit a credential that does not exist.");
			onGoBack();
		}
	}, [isLoading, data, onGoBack]);

	/**
	 * Shows a loading indicator while fetching the credential data.
	 */
	if (isLoading || !data) {
		return <Splash message="Loading credential details..." />;
	}

	/**
	 * Renders the Edit Credential page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Edit Credentials"
					description="Credentials are used to authenticate SIP Agents and Trunks within your network."
					onBack={{ label: "Back to credentials", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save Credential
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateCredentialForm
						onSubmit={onSave}
						initialValues={{ password: "", ...data }}
						isEdit={true}
					/>
				</Box>
			</Page>
		</FormProvider>
	);
}
