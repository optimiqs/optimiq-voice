import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem } from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Input } from "~/core/components/design-system/ui/input/input";
import { Modal } from "~/core/components/design-system/ui/modal/modal";
import { Select } from "~/core/components/design-system/ui/select/select";

/**
 * Zod validation schema for the Create/Edit ACL Rule form.
 *
 * Ensures:
 * - A human-friendly name is required.
 * - The type is either "allow" or "deny".
 */
export const schema = z.object({
	/**
	 * IP or CIDR range of the rule.
	 *
	 * Required; cannot be empty.
	 */
	name: z.string().nonempty("IP or CIDR is required"),

	/**
	 * Type of the rule (allow or deny).
	 *
	 * Required; must be either "allow" or "deny".
	 */
	type: z.enum(["allow", "deny"]),
});

/**
 * Type representing the validated data structure for the form.
 *
 * This type helps with strong typing in the form state, handlers, and submissions.
 */
export type Schema = z.infer<typeof schema>;

/**
 * Props interface for the CreateRuleModal component.
 *
 * @property {boolean} isOpen - Controls the visibility of the modal.
 * @property {() => void} onClose - Function to close the modal.
 * @property {(data: Schema) => void} onFormSubmit - Function triggered when the form is successfully submitted.
 */
export interface ModalProps {
	isOpen: boolean;
	onClose: () => void;
	onFormSubmit: (data: Schema) => void;
}

/**
 * CreateRuleModal component.
 *
 * Renders a modal dialog containing a form to create a new ACL rule.
 * Uses React Hook Form for form state management and Zod for validation.
 *
 * When the form is submitted:
 * - Calls the onFormSubmit callback with the validated data.
 * - Closes the modal and resets the form state.
 *
 * @param {ModalProps} props - The component props controlling visibility and form behavior.
 * @returns {JSX.Element} The rendered modal containing the rule creation form.
 */
export const CreateRuleModal = ({ isOpen, onClose, onFormSubmit }: ModalProps) => {
	/**
	 * Initializes React Hook Form with Zod validation and default values.
	 */
	const form = useForm<Schema>({
		resolver: zodResolver(schema),
		defaultValues: {
			name: "",
			type: "allow",
		},
		mode: "onChange",
	});

	/**
	 * Handles the form submission.
	 *
	 * Calls the parent-provided onFormSubmit function with the validated data,
	 * closes the modal, and resets the form after a short delay to avoid visual flicker.
	 *
	 * @param {Schema} data - The validated form data.
	 */
	const onSubmit = (data: Schema) => {
		onFormSubmit(data);
		onClose(); // Close the modal
	};

	return (
		<Modal open={isOpen} onClose={onClose} title="Create New Rule">
			<Form {...form}>
				<FormRoot onSubmit={form.handleSubmit(onSubmit)}>
					{/* IP or CIDR Field */}
					<FormField
						control={form.control}
						name="name"
						render={({ field }) => (
							<FormItem>
								<FormControl>
									<Input type="text" label="IP or CIDR" placeholder="0.0.0.0/0" {...field} />
								</FormControl>
							</FormItem>
						)}
					/>

					{/* Rule Type Field */}
					<FormField
						control={form.control}
						name="type"
						render={({ field }) => (
							<FormItem>
								<FormControl>
									<Select
										label="Category"
										options={[
											{ value: "allow", label: "Allow" },
											{ value: "deny", label: "Deny" },
										]}
										{...field}
									/>
								</FormControl>
							</FormItem>
						)}
					/>

					{/* Submit Button */}
					<Button type="submit" disabled={!form.formState.isValid} isFullWidth size="small">
						Save Rule
					</Button>
				</FormRoot>
			</Form>
		</Modal>
	);
};
