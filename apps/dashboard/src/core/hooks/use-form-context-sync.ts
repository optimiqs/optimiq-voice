import { useEffect, useCallback, useRef } from "react";
import { useFormContext } from "../contexts/form-context";
import type { UseFormReturn } from "react-hook-form";

/**
 * Hook that synchronizes react-hook-form state with the form context
 * This allows components outside the form hierarchy to access form state
 */
export function useFormContextSync<T extends Record<string, any>>(
	form: UseFormReturn<T>,
	onSubmit?: (data: T) => void,
	_isEdit?: boolean,
) {
	const { setFormState, setSubmitHandler } = useFormContext();

	const formRef = useRef(form);
	formRef.current = form;

	// Use refs to stabilize the callbacks
	const onSubmitRef = useRef(onSubmit);
	onSubmitRef.current = onSubmit;

	const lastSyncedFormStateRef = useRef<{
		isValid: boolean;
		isSubmitting: boolean;
		isDirty: boolean;
		hasErrors: boolean;
	} | null>(null);

	// Keep a stable submit handler so FormProvider is not updated every render
	const submitForm = useCallback(() => {
		if (onSubmitRef.current) {
			formRef.current.handleSubmit(onSubmitRef.current)();
		}
	}, []);

	// Initialize submit handler on mount
	useEffect(() => {
		setSubmitHandler(submitForm);
	}, [submitForm, setSubmitHandler]);

	const errorKeyCount = Object.keys(form.formState.errors).length;
	const hasErrors = errorKeyCount > 0;

	// Update form state whenever form state changes
	useEffect(() => {
		const next = {
			isValid: form.formState.isValid,
			isSubmitting: form.formState.isSubmitting,
			isDirty: form.formState.isDirty,
			hasErrors,
		};
		const prev = lastSyncedFormStateRef.current;
		if (
			prev &&
			prev.isValid === next.isValid &&
			prev.isSubmitting === next.isSubmitting &&
			prev.isDirty === next.isDirty &&
			prev.hasErrors === next.hasErrors
		) {
			return;
		}
		lastSyncedFormStateRef.current = next;
		setFormState(next);
	}, [
		form.formState.isValid,
		form.formState.isSubmitting,
		form.formState.isDirty,
		hasErrors,
		setFormState,
	]);

	return {
		submitForm,
	};
}
