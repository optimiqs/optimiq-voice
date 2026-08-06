"use client";

import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import {
	clearConferencePin,
	deleteMohFile,
	deletePrompt,
	deleteVoicemailGreeting,
	listMohFiles,
	listPrompts,
	listVoicemailGreetings,
	mintGreetingPlaybackUrl,
	mintPromptPlaybackUrl,
	setConferencePin,
	setVoicemailGreetingActive,
	updatePrompt,
	uploadMohFile,
	uploadPrompt,
	uploadVoicemailGreeting,
	type ConferencePinRole,
	type PromptListQuery,
} from "~/lib/pbx/client";
import { pbxToastMessage } from "~/lib/pbx/errors";
import { queryKeys } from "~/lib/query-keys";
import { useActiveOrganization } from "../_context/session-context";
import type {
	ConferencePinState,
	MediaPlaybackLink,
	MutationEnvelope,
	PagedEnvelope,
	PromptRow,
	VoicemailGreetingKind,
	VoicemailGreetingRow,
} from "~/lib/pbx/contracts";

/**
 * Server state for the media library, the mailbox greetings and the conference PINs.
 *
 * ## Why these are not in `use-pbx-queries.ts`
 *
 * That file is the generic CRUD machinery: every hook is parameterised by a
 * `PbxResourceDescriptor`, every read is `listPbx`/`getPbx`, and every write is a JSON body. Three
 * things here break that shape, and each of them would have to become a special case inside
 * machinery that eleven other resources depend on:
 *
 * 1. **Creation is an upload.** `prompt.object_key` and `voicemail_greeting.object_key` are
 *    `notNull`, so neither row can exist without audio; the create path is `multipart/form-data`
 *    through `apiUpload`, which `createPbx` cannot express.
 * 2. **Two lists take filters the descriptor has no vocabulary for.** The library narrows by
 *    `kind`, and a class's files are a sub-collection that is not a `PbxChildResource` (the child
 *    machinery has no seam for a multipart create either).
 * 3. **Activation is a verb, not a field.** Making a greeting active is a two-row write on the
 *    server, so it is a `POST …/activate` rather than a `PATCH { active }`.
 *
 * The generic hooks are still used where they fit: `PBX_RESOURCES.mohClasses`,
 * `PBX_RESOURCES.prompts` (for read/patch/delete) and `PBX_RESOURCES.emergencyAddresses` are
 * ordinary descriptors and their screens use `usePbxList` / `usePbxCreate` / `usePbxUpdate`.
 *
 * ## What each mutation invalidates, and why the answers differ
 *
 * | write                     | routing input? | invalidates                                   |
 * | ------------------------- | -------------- | --------------------------------------------- |
 * | upload / delete a prompt  | no             | the prompt subtree only                        |
 * | upload / delete MOH file  | no             | the class's file list and the prompt subtree   |
 * | any greeting write        | **yes**        | the mailbox subtree AND the compile view       |
 * | any conference PIN write  | **yes**        | the conference subtree AND the compile view    |
 *
 * `prompt` is deliberately absent from `ROUTING_TABLE_TO_ENTITY` — the compiler copies a
 * `promptId` into a plan node verbatim and never resolves it — so uploading audio must not make the
 * compile banner claim the tenant needs recompiling. `voicemail_greeting` and `conference` are in
 * that map, so they must.
 */

function useOrganizationId(): string {
	return useActiveOrganization()?.id ?? "";
}

// ---------------------------------------------------------------------------------------------
// The prompt library
// ---------------------------------------------------------------------------------------------

export function usePromptList(query: PromptListQuery): UseQueryResult<PagedEnvelope<PromptRow>> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.promptList(organizationId, { ...query }),
		queryFn: () => listPrompts(query),
		enabled: organizationId.length > 0,
	});
}

export interface PromptUploadInput {
	readonly file: File;
	readonly name?: string | undefined;
	readonly language?: string | undefined;
}

/**
 * Uploads a prompt.
 *
 * No toast on failure: an upload is refused for a reason the FORM has room to explain in full — the
 * file is not audio the media server can play, it is over the size cap, the name is taken — and a
 * toast that vanishes in four seconds is the wrong container for a sentence somebody has to act on.
 * The success toast stays, because a successful upload closes the dialog and the row appearing in a
 * list is not, on its own, obviously the thing that just happened.
 */
export function usePromptUpload(): UseMutationResult<
	MutationEnvelope<PromptRow>,
	Error,
	PromptUploadInput
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ file, name, language }: PromptUploadInput) =>
			uploadPrompt(file, {
				...(name === undefined || name === "" ? {} : { name }),
				...(language === undefined || language === "" ? {} : { language }),
			}),
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "prompts"),
			});
			toast.success(`Uploaded ${result.data.name}`);
		},
	});
}

export function usePromptUpdate(): UseMutationResult<
	MutationEnvelope<PromptRow>,
	Error,
	{ readonly promptId: string; readonly name?: string; readonly language?: string }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ promptId, ...values }) => updatePrompt(promptId, values),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "prompts"),
			});
			toast.success("Prompt saved");
		},
	});
}

/**
 * Deletes a prompt.
 *
 * A `409` here is the reference guard: eight foreign keys point at `prompt` and all eight are
 * `on delete set null`, so the server refuses rather than silently returning an IVR to its default
 * announcement. `pbxToastMessage` renders the referring rows, which is the only useful form of that
 * message — "still in use" without saying by what is a message that makes the user go looking.
 */
export function usePromptDelete(): UseMutationResult<
	MutationEnvelope<{ id: string }>,
	Error,
	string
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: (promptId: string) => deletePrompt(promptId),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "prompts"),
			});
			toast.success("Prompt deleted");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "This prompt could not be deleted."));
		},
	});
}

/** Mints a preview link. A mutation, never a query, so a live grant is never held in a cache. */
export function usePromptPlaybackUrl(): UseMutationResult<MediaPlaybackLink, Error, string> {
	return useMutation({ mutationFn: (promptId: string) => mintPromptPlaybackUrl(promptId) });
}

// ---------------------------------------------------------------------------------------------
// Hold-music files
// ---------------------------------------------------------------------------------------------

export function useMohFiles(mohClassId: string | null): UseQueryResult<readonly PromptRow[]> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.mohClassFiles(organizationId, mohClassId ?? "none"),
		queryFn: () => listMohFiles(mohClassId ?? ""),
		enabled: organizationId.length > 0 && mohClassId !== null,
	});
}

/**
 * Uploads a file into a class.
 *
 * Invalidates BOTH the class's file list and the prompt subtree: the row is a `prompt` row, so a
 * library list filtered to `kind=moh` would otherwise miss it. Two invalidations rather than one
 * broad `pbx` sweep, because a broad sweep would evict every extension, queue and route page a user
 * has open for an upload none of them can see.
 */
export function useMohFileUpload(): UseMutationResult<
	MutationEnvelope<PromptRow>,
	Error,
	{ readonly mohClassId: string; readonly file: File; readonly name?: string }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ mohClassId, file, name }) =>
			uploadMohFile(mohClassId, file, name === undefined || name === "" ? {} : { name }),
		onSuccess: async (result, variables) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.mohClassFiles(organizationId, variables.mohClassId),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "prompts"),
			});
			toast.success(`Uploaded ${result.data.name}`);
		},
	});
}

export function useMohFileDelete(): UseMutationResult<
	MutationEnvelope<{ id: string }>,
	Error,
	{ readonly mohClassId: string; readonly fileId: string }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ mohClassId, fileId }) => deleteMohFile(mohClassId, fileId),
		onSuccess: async (_result, variables) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.mohClassFiles(organizationId, variables.mohClassId),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "prompts"),
			});
			toast.success("File removed");
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, "This file could not be removed."));
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Voicemail greetings
// ---------------------------------------------------------------------------------------------

export function useVoicemailGreetings(
	boxId: string | null,
): UseQueryResult<readonly VoicemailGreetingRow[]> {
	const organizationId = useOrganizationId();
	return useQuery({
		queryKey: queryKeys.voicemailGreetings(organizationId, boxId ?? "none"),
		queryFn: () => listVoicemailGreetings(boxId ?? ""),
		enabled: organizationId.length > 0 && boxId !== null,
	});
}

/**
 * Every greeting write, in one hook.
 *
 * All four — upload, activate, deactivate, delete — invalidate the same two things and say the same
 * thing about why: `voicemail_greeting` IS a routing input, the compiled artifact carries the
 * ACTIVE greeting's object key as `object://<key>`, so any of these changes what a caller hears and
 * the compile view has to notice.
 */
function useGreetingWrite<TVariables, TResult>(
	mutationFn: (variables: TVariables) => Promise<TResult>,
	boxIdOf: (variables: TVariables) => string,
	successMessage: (result: TResult) => string,
	failureMessage: string,
): UseMutationResult<TResult, Error, TVariables> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn,
		onSuccess: async (result, variables) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.voicemailGreetings(organizationId, boxIdOf(variables)),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			toast.success(successMessage(result));
		},
		onError: (error) => {
			toast.error(pbxToastMessage(error, failureMessage));
		},
	});
}

export interface GreetingUploadInput {
	readonly boxId: string;
	readonly file: File;
	readonly kind: VoicemailGreetingKind;
	readonly label?: string | undefined;
	readonly active: boolean;
}

export function useGreetingUpload(): UseMutationResult<
	MutationEnvelope<VoicemailGreetingRow>,
	Error,
	GreetingUploadInput
> {
	return useGreetingWrite(
		({ boxId, file, kind, label, active }: GreetingUploadInput) =>
			uploadVoicemailGreeting(boxId, file, {
				kind,
				active,
				...(label === undefined || label === "" ? {} : { label }),
			}),
		(variables) => variables.boxId,
		(result) => (result.data.active ? "Greeting uploaded and active" : "Greeting uploaded"),
		"This greeting could not be uploaded.",
	);
}

export function useGreetingActivation(): UseMutationResult<
	MutationEnvelope<VoicemailGreetingRow>,
	Error,
	{ readonly boxId: string; readonly greetingId: string; readonly active: boolean }
> {
	return useGreetingWrite(
		({ boxId, greetingId, active }) => setVoicemailGreetingActive(boxId, greetingId, active),
		(variables) => variables.boxId,
		(result) => (result.data.active ? "Greeting is now active" : "Greeting stood down"),
		"This greeting could not be changed.",
	);
}

export function useGreetingDelete(): UseMutationResult<
	MutationEnvelope<{ id: string }>,
	Error,
	{ readonly boxId: string; readonly greetingId: string }
> {
	return useGreetingWrite(
		({ boxId, greetingId }) => deleteVoicemailGreeting(boxId, greetingId),
		(variables) => variables.boxId,
		() => "Greeting deleted",
		"This greeting could not be deleted.",
	);
}

export function useGreetingPlaybackUrl(): UseMutationResult<
	MediaPlaybackLink,
	Error,
	{ readonly boxId: string; readonly greetingId: string }
> {
	return useMutation({
		mutationFn: ({ boxId, greetingId }) => mintGreetingPlaybackUrl(boxId, greetingId),
	});
}

// ---------------------------------------------------------------------------------------------
// Conference PINs
// ---------------------------------------------------------------------------------------------

/**
 * Sets or clears a conference PIN.
 *
 * One mutation covering both, branching on `pin === null`, exactly as `useVoicemailPin` does — and
 * for the same reason: the dialog's two controls do one thing to one credential, and two hooks
 * would be two places to remember that `conference` is a routing input.
 *
 * It IS one: setting a participant PIN flips `ConferencePlanNode.requiresPin` in the compiled
 * artifact, so the compile view is invalidated. The MODERATOR pin is stored and reaches nothing
 * downstream today (`ConferenceInput` in `@optimiq-voice/routing` has no moderator field), and it
 * still invalidates — a recompile that produced an identical hash is a provable no-op, and a hook
 * that tried to be clever about which of the two mattered would be a second copy of a rule the
 * server already applies.
 *
 * No toast on failure: the PIN form renders the message under its own input, where it can be
 * re-read and acted on.
 */
export function useConferencePin(): UseMutationResult<
	MutationEnvelope<ConferencePinState>,
	Error,
	{ readonly conferenceId: string; readonly role: ConferencePinRole; readonly pin: string | null }
> {
	const queryClient = useQueryClient();
	const organizationId = useOrganizationId();

	return useMutation({
		mutationFn: ({ conferenceId, role, pin }) =>
			pin === null
				? clearConferencePin(conferenceId, role)
				: setConferencePin(conferenceId, role, pin),
		onSuccess: async (result, variables) => {
			await queryClient.invalidateQueries({
				queryKey: queryKeys.pbxResource(organizationId, "conferences"),
			});
			await queryClient.invalidateQueries({
				queryKey: queryKeys.routingCompile(organizationId),
			});
			const isSet =
				variables.role === "moderator" ? result.data.moderatorPinSet : result.data.pinSet;
			const noun = variables.role === "moderator" ? "Moderator PIN" : "Room PIN";
			toast.success(isSet ? `${noun} set` : `${noun} cleared`);
		},
	});
}
