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
import { useNumber, useUpdateNumber } from "~/numbers/services/numbers.service";
import { useWorkspaceId } from "~/workspaces/hooks/use-workspace-id";
import { COUNTRIES } from "../create-number/create-number.const";
import { CreateNumberForm, type Schema } from "../create-number/create-number.form";
import type { Route } from "./+types/edit-number.page";

/**
 * Sets the metadata for the "Edit Number" page.
 *
 * This information is used by the router to define the page title and description
 * for SEO and display in the browser.
 *
 * @param _ - Meta arguments provided by the router (unused here).
 * @returns {Array} Metadata objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Numbers | Optimiq Voice" },
		{
			name: "description",
			content: "A Number is a PSTN phone number that can be used to make or receive calls.",
		},
	];
}

/**
 * EditNumber page component.
 *
 * Renders a page to edit an existing voice number, including:
 * - Page header with back navigation and save button.
 * - A form pre-filled with the number details.
 * - Data fetching and optimistic update integration.
 *
 * @returns {JSX.Element} The rendered Edit Number page.
 */
export default function EditNumber() {
	/** Retrieves the current workspace ID for building navigation paths. */
	const workspaceId = useWorkspaceId();

	/** Extracts the number reference from the URL parameters. */
	const { ref } = useParams();

	/**
	 * Ensures the number reference is provided.
	 *
	 * This value should never be null or undefined, as it is required
	 * to fetch and update the number data.
	 */
	if (!ref) {
		throw new Error("Number reference is required");
	}

	/** Fetches the existing number details for editing. */
	const { data, isLoading } = useNumber(ref);

	/** Hook to programmatically navigate between pages. */
	const navigate = useNavigate();

	/**
	 * Handler for navigating back to the numbers page.
	 * Uses `viewTransition` for smoother transitions.
	 */
	const onGoBack = useCallback(() => {
		navigate(`/workspaces/${workspaceId}/sip-network/numbers`, {
			viewTransition: true,
		});
	}, [navigate, workspaceId]);

	/** Custom hook to handle number updates via the API. */
	const { mutate } = useUpdateNumber();

	/**
	 * Handler called after form submission.
	 * Updates the number, shows a toast, and navigates back to the numbers page.
	 *
	 * @param {Schema} data - The validated form data.
	 */
	const onSave = useCallback(
		async ({ country: countryIsoCode, ...data }: Schema) => {
			try {
				const country = COUNTRIES.find(({ value }) => value === countryIsoCode);

				if (!country) {
					toast("Oops! Invalid country selected.");
					return;
				}

				mutate({ ...data, ref });
				toast("Number updated successfully!");
				onGoBack();
			} catch (error) {
				toast(getErrorMessage(error));
			}
		},
		[mutate, ref, onGoBack],
	);

	/**
	 * Effect that ensures the user is redirected if the number does not exist.
	 * Shows an error toast and navigates back to the numbers page.
	 */
	useEffect(() => {
		if (!isLoading && !data) {
			toast("Oops! You are trying to edit a number that does not exist.");
			onGoBack();
		}
	}, [isLoading, data, onGoBack]);

	/**
	 * Shows a loading indicator while fetching the number data.
	 */
	if (isLoading || !data) {
		return <Splash message="Loading number details..." />;
	}

	// Transform the data to match the form schema
	const transformedData = {
		...data,
		trunkRef: data.trunk?.ref,
		country: data.countryIsoCode,
	};

	/**
	 * Renders the Edit Number page layout.
	 */
	return (
		<FormProvider>
			<Page variant="form">
				<PageHeader
					title="Edit Number"
					description="A Number is a PSTN phone number that can be used to make or receive calls."
					onBack={{ label: "Back to voice numbers", onClick: onGoBack }}
					actions={
						<FormSubmitButton size="small" loadingText="Saving...">
							Save Number
						</FormSubmitButton>
					}
				/>

				{/* Form container with a max width for readability and consistent layout */}
				<Box sx={{ maxWidth: "440px" }}>
					<CreateNumberForm onSubmit={onSave} initialValues={transformedData} isEdit={true} />
				</Box>
			</Page>
		</FormProvider>
	);
}
