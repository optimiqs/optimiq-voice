"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { inputClassName } from "~/components/ui/field";
import { toast } from "~/components/ui/toast";
import { uploadBrandingLogo, updateBranding } from "~/lib/branding/client";
import { type Branding } from "~/lib/branding/contracts";
import {
	brandingLogoPreviewSrc,
	BRANDING_LOGO_ACCEPT,
	validateLogoFile,
} from "~/lib/branding/logo";
import { cn } from "~/lib/cn";
import { pbxFieldErrors, pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization, usePermission } from "../../../_context/session-context";

/**
 * The logo control: choose an image, upload it, see it, remove it.
 *
 * ## Why this is not a `TextField` on the branding form
 *
 * It used to be one — a raw `logoObjectKey` input whose help text called upload "a pending media
 * seam". The seam shipped (`POST /api/v1/branding/logo`, magic-byte sniffed, namespaced under
 * `branding/`, 2 MiB capped), and an object key is not something an administrator can obtain
 * through the product, so a text field asking for one was a control nobody could use. The bytes and
 * the row are now written by one request, which is also why this does NOT live inside the branding
 * form's submit: an upload is its own atomic write that returns the re-resolved branding, and
 * making it wait for "Save branding" would mean holding a `File` in form state to no purpose.
 *
 * Removal is the other half and IS an ordinary PATCH — `logoObjectKey: null`, the same clear the
 * cascade stores for every other unset override — so it goes through `updateBranding` rather than
 * inventing a DELETE the API does not serve.
 *
 * ## Both mutations write the branding cache, and the shell follows
 *
 * Each mutation seeds `queryKeys.branding(organizationId)` with the resolved result and then
 * invalidates it, exactly as `useSaveBranding` does. That is what makes the sidebar lockup change
 * in the same tick — it reads the same query — and the preview's `?v=<objectKey>` token is what
 * stops the browser serving the previous image from the `private, max-age=300` the logo route sends.
 */
export function BrandingLogoField({ brand }: { readonly brand: Branding }) {
	const fileInputId = useId();
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [file, setFile] = useState<File | null>(null);
	const [fileError, setFileError] = useState<string | undefined>(undefined);

	const organizationId = useActiveOrganization()?.id ?? "";
	const canWrite = usePermission("branding.write");
	const queryClient = useQueryClient();

	/** Seed the cache with the resolved brand, then reconcile — the shape both writes share. */
	async function settle(result: Branding): Promise<void> {
		queryClient.setQueryData(queryKeys.branding(organizationId), result);
		await queryClient.invalidateQueries({ queryKey: queryKeys.branding(organizationId) });
	}

	const upload = useMutation({
		mutationFn: (chosen: File) => uploadBrandingLogo(chosen),
		onSuccess: async (result) => {
			await settle(result);
			clearChoice();
			toast.success("Logo uploaded", {
				description: "It appears in the app shell and on the sign-in page immediately.",
			});
		},
	});

	const remove = useMutation({
		mutationFn: () => updateBranding({ logoObjectKey: null }),
		onSuccess: async (result) => {
			await settle(result);
			toast.success("Logo removed", { description: "The built-in mark is shown again." });
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "Could not remove the logo"));
		},
	});

	const currentKey = brand.logoObjectKey;
	const previewSrc = brandingLogoPreviewSrc(brand, currentKey);
	const busy = upload.isPending || remove.isPending;

	function clearChoice(): void {
		setFile(null);
		setFileError(undefined);
		if (fileInputRef.current !== null) {
			fileInputRef.current.value = "";
		}
	}

	/**
	 * The server addresses a refused upload at the `file` part (`MEDIA_UPLOAD_REJECTED` carries an
	 * `issues[]`), and a 413 carries only a sentence — so a field error wins and the message is the
	 * fallback. Both belong next to the input rather than in a toast that vanishes.
	 */
	const uploadError = upload.isError
		? (pbxFieldErrors(upload.error).file ??
			pbxToastMessage(upload.error, "That image could not be uploaded."))
		: undefined;
	const shownError = fileError ?? uploadError;

	return (
		<div className="flex flex-col gap-2">
			<span className="text-sm font-medium text-foreground">Logo</span>
			<p className="text-xs text-muted-foreground">
				A PNG, JPEG, WebP or SVG up to 2 MB. It replaces the built-in mark in the app shell and on
				the sign-in page. Leave it unset to keep the default.
			</p>

			<div className="flex flex-wrap items-center gap-4">
				<div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-panel border border-border bg-surface">
					{previewSrc === null ? (
						<span className="text-xs text-muted-foreground">None</span>
					) : (
						/*
						 * A background rather than an `<img>`, the same choice the sidebar lockup makes:
						 * the bytes come from an API route rather than a host in `next/image`'s remote
						 * allowlist, and `background-image` handles a `data:` logo with no config. The
						 * mark itself is decorative: the sibling below says in words whether a logo is
						 * set, which is the part a screen reader can act on.
						 */
						<span
							aria-hidden="true"
							data-testid="branding-logo-preview"
							className="size-14 bg-contain bg-center bg-no-repeat"
							style={{ backgroundImage: `url(${JSON.stringify(previewSrc)})` }}
						/>
					)}
					<span className="sr-only">
						{previewSrc === null ? "No logo is set" : "Your organization's logo"}
					</span>
				</div>

				<div className="flex min-w-56 flex-1 flex-col gap-1.5">
					<label htmlFor={fileInputId} className="text-xs font-medium text-muted-foreground">
						Choose an image
					</label>
					<input
						id={fileInputId}
						ref={fileInputRef}
						type="file"
						/*
						 * A hint the picker filters on, never a guarantee: the server re-decides from the
						 * magic bytes, so a renamed file gets past every check a browser can make.
						 */
						accept={BRANDING_LOGO_ACCEPT}
						disabled={busy || !canWrite}
						onChange={(event) => {
							const chosen = event.target.files?.[0] ?? null;
							upload.reset();
							setFile(chosen);
							setFileError(chosen === null ? undefined : validateLogoFile(chosen));
						}}
						className={cn(inputClassName, "h-auto py-1.5 file:mr-3 file:text-sm")}
						aria-describedby={shownError === undefined ? undefined : `${fileInputId}-error`}
						aria-invalid={shownError === undefined ? undefined : true}
					/>
				</div>

				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						loading={upload.isPending}
						disabled={!canWrite || file === null || fileError !== undefined || remove.isPending}
						onClick={() => {
							if (file !== null && fileError === undefined) {
								upload.mutate(file);
							}
						}}
					>
						Upload logo
					</Button>
					{currentKey === null ? null : (
						<Button
							type="button"
							variant="ghost"
							loading={remove.isPending}
							disabled={!canWrite || upload.isPending}
							onClick={() => remove.mutate()}
						>
							Remove logo
						</Button>
					)}
				</div>
			</div>

			{shownError === undefined ? null : (
				<p id={`${fileInputId}-error`} role="alert" className="text-xs text-danger">
					{shownError}
				</p>
			)}
		</div>
	);
}
