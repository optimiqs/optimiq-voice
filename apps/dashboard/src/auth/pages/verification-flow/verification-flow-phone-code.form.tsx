import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem } from "~/core/components/design-system/forms";
import { FormRoot } from "~/core/components/design-system/forms/form-root";
import { Button } from "~/core/components/design-system/ui/button/button";
import { Input } from "~/core/components/design-system/ui/input/input";

export const schema = z.object({
	code: z.string().min(6, "Verification code must be at least 6 digits"),
});

export const resolver = zodResolver(schema);
export type Schema = z.infer<typeof schema>;
export type Form = UseFormReturn<Schema>;

export interface VerificationFlowPhoneCodeProps extends React.PropsWithChildren {
	onSubmit: (data: Schema, form: Form) => Promise<void>;
	phoneNumber: string;
}

export function VerificationFlowPhoneCode({
	onSubmit,
	phoneNumber,
	resendSlot,
}: VerificationFlowPhoneCodeProps & { resendSlot?: React.ReactNode }) {
	const form = useForm<Schema>({
		resolver,
		defaultValues: { code: "" },
		mode: "onChange",
	});

	const onSubmitForm = useCallback(async (data: Schema) => onSubmit(data, form), [onSubmit, form]);

	return (
		<Form {...form}>
			<FormRoot onSubmit={form.handleSubmit(onSubmitForm)}>
				<FormField
					control={form.control}
					name="code"
					render={({ field }) => (
						<FormItem>
							<FormControl>
								<Input
									type="text"
									label="Verification Code"
									supportingText={`Enter the code sent to ${phoneNumber}`}
									{...field}
								/>
							</FormControl>
						</FormItem>
					)}
				/>
				<Button
					type="submit"
					disabled={form.formState.isSubmitting || !form.formState.isValid}
					isFullWidth
				>
					Verify Phone Number
				</Button>
				{/* Resend/timer slot */}
				{resendSlot && <div style={{ marginTop: 16 }}>{resendSlot}</div>}
			</FormRoot>
		</Form>
	);
}
