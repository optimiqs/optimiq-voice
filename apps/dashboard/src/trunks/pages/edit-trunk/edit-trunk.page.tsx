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
import { useTrunk, useUpdateTrunk } from "~/trunks/services/trunks.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { CreateTrunkForm } from "../create-trunk/create-trunk.form";
import type { Schema } from "../create-trunk/create-trunk.schema";
import type { Route } from "./+types/edit-trunk.page";

/**
 * Sets the metadata for the "Edit Trunk" page.
 *
 * This information is used by the router to define the page title and description
 * for SEO and display in the browser.
 *
 * @param _ - Meta arguments provided by the router (unused here).
 * @returns {Array} Metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Edit SIP Trunk | Optimiq Voice" },
		{
			name: "description",
			content:
				"A VoIP Provider is a resource within the Optimiq Voice network that handles PSTN connectivity. ",
		},
	];
}

/**
 * EditTrunk page component.
 *
 * Renders a page to edit an existing voice trunk, including:
 * - Page header with back navigation and save button.
 * - A form pre-filled with the trunk details.
 * - Data fetching and optimistic update integration.
 *
 * @returns {JSX.Element} The rendered Edit Trunk page.
 */
export default function EditTrunk() {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Extracts the trunk reference from the URL parameters. */
	const { ref } = useParams();

	/**
	 * Ensures the trunk reference is provided.
	 *
	 * This value should never be null or undefined, as it is required
	 * to fetch and update the trunk data.
	 */
	if (!ref) {
		throw new Error("Trunk reference is required");
	}

	/** Fetches the existing trunk details for editing. */
	const { data, isLoading } = useTrunk(ref);

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the trunks page.
	 * Uses `viewTransition` for smoother transitions.
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/trunks`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to handle trunk updates via the API. */
	const { mutate } = useUpdateTrunk();

	/**
	 * Handler called after form submission.
	 * Updates the trunk, shows a toast, and navigates back to the trunks page.
	 *
	 * @param {Schema} data - The validated form data.
	 */
	const onSave = useCallback(
		async ({ name }: Schema) => {
			try {
				mutate({ name, ref });
				toast("Trunk updated successfully!");
				onGoBack();
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutate, ref, onGoBack],
	);

	/**
	 * Effect that ensures the user is redirected if the trunk does not exist.
	 * Shows an error toast and navigates back to the trunks page.
	 */
	useEffect(() => {
		if (!isLoading && !data) {
			toast("Oops! You are trying to edit a trunk that does not exist.");
			onGoBack();
		}
	}, [isLoading, data, onGoBack]);

	/**
	 * Shows a loading indicator while fetching the trunk data.
	 */
	if (isLoading || !data) {
		return <Splash message="Loading trunk details..." />;
	}

	/**
	 * Renders the Edit Trunk page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Edit SIP Trunk"
					description="A VoIP Provider is a resource within the Optimiq Voice network that handles PSTN connectivity. "
					onBack={{ label: "Back to trunks", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save Trunk
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateTrunkForm
						onSubmit={onSave}
						initialValues={{ inboundUri: "", ...data }}
						isEdit={true}
					/>
				</Box>
			</Page>
		</FormProvider>
	);
}
