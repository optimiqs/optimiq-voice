import { ApplicationProvider } from "~/applications/stores/application.store";
import { FormProvider } from "~/core/contexts/form-context";
import { EditApplicationContainer } from "./edit-application.container";
import type { Route } from "./+types/edit-application.page";

/**
 * Sets the metadata for the "Create Application" page.
 * Used by the router to define the page title and description.
 *
 * @param _ - Meta arguments (unused).
 * @returns Array of meta objects for the page.
 */
export function meta(_: Route.MetaArgs) {
	return [
		{ title: "Voice Applications | Optimiq Voice" },
		{
			name: "description",
			content:
				"An Application defines how your Voice AI behaves. Use Autopilot for LLM-based agents or External for custom logic.",
		},
	];
}

/**
 * Page component for creating a new voice application.
 * Includes:
 *  - Page header with navigation and actions.
 *  - Form for application details.
 *  - Save and Test Call actions.
 */
export default function EditApplication() {
	return (
		<ApplicationProvider>
			<FormProvider>
				<EditApplicationContainer />
			</FormProvider>
		</ApplicationProvider>
	);
}
