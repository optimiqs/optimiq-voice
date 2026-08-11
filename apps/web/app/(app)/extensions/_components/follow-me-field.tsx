"use client";

import { FormSection } from "~/components/pbx/entity-form-dialog";
import { Button } from "~/components/ui/button";
import { SwitchField, TextField, type FieldLike } from "~/components/ui/form-fields";
import { EMPTY_FOLLOW_ME_TARGET, moveFollowMeTarget } from "~/lib/pbx/follow-me";
import { MAX_FOLLOW_ME_TARGETS, type FollowMeFormValues } from "~/lib/pbx/schemas";
import type { FollowMeTargetFormValues } from "~/lib/pbx/schemas";

/**
 * The follow-me ladder, as a control.
 *
 * ## Why it is a section of the extension dialog and not a screen of its own
 *
 * `follow_me` is a JSON column on `extension`, not a child table — there is no
 * `/extensions/:id/follow-me` to page through, and no id per rung. A ring group's members are a
 * child collection precisely because they ARE rows, which is what earns them their own panel. This
 * is one field of one row, so it is edited where the rest of that row is edited and saved by the
 * same PATCH.
 *
 * ## Order is the meaning, so it is a list with Up/Down
 *
 * The ladder is walked in order, and each rung's delay is measured from the start of the call — so
 * moving a rung changes which phone rings first. That is not expressible in a multi-select, and the
 * affordance is the one `ResourceOrderedList` already uses for the trunk chain: numbered rows with
 * Up, Down and Remove. Drag-and-drop is not offered anywhere in this app, and a keyboard user
 * reordering a phone chain is not a fringe case.
 *
 * ## Confirmation is per-rung, and the copy says what it is for
 *
 * A mobile with voicemail ANSWERS. Without confirmation the ladder stops there, the caller reaches
 * the carrier's mailbox instead of the desk phone two rungs down, and nothing on any screen looks
 * wrong. So the switch sits on the rung it protects rather than on the ladder, because a desk phone
 * and a mobile in the same ladder do not want the same answer.
 */

const COPY = {
	section:
		"An ordered ladder of places to chase this extension's calls — the desk phone, then a mobile, " +
		"then anywhere else. Each rung starts ringing after its own delay, measured from the start of " +
		"the call, and stops after its own timeout.",
	enabled:
		"Off keeps the ladder stored but takes no call down it. Calls ring this extension's registered " +
		"devices and nothing else.",
	ignoreBusy: "Skip a rung whose extension is already on a call, instead of ringing it anyway.",
	destination:
		"An extension number (1002) or an external number in E.164 (+12125550100). External numbers " +
		"leave over an outbound route, so this extension's toll class has to cover them.",
	delay: "Measured from the start of the call, not from the previous rung. 0 rings immediately.",
	timeout: "How long this rung rings before the ladder gives up on it.",
	confirm:
		"The callee must press 1 to accept — this stops a mobile's voicemail from taking the call.",
	empty:
		"No rungs yet. A ladder with none rings nobody, so the call falls straight through to whatever " +
		"handles an unanswered extension.",
	full: `At most ${MAX_FOLLOW_ME_TARGETS} rungs — the same ceiling the API enforces.`,
};

/**
 * A TanStack-Form-shaped field over a plain value.
 *
 * `FieldLike` exists so the design system's field components do not depend on the form library's
 * generics, and this is the case its doc anticipates: the ladder is held in `useState` beside the
 * form — the same way the trunk chain and the destination trios are — because a nested array of
 * objects is not what `defaultValues` is good at. The adapter is what lets these rows use exactly
 * the same `TextField` and `SwitchField` as every other control in the dialog.
 */
function fieldLike<TValue>(
	name: string,
	value: TValue,
	onChange: (next: TValue) => void,
): FieldLike<TValue> {
	return {
		name,
		handleBlur: () => {},
		handleChange: (updater) => {
			onChange(
				typeof updater === "function" ? (updater as (previous: TValue) => TValue)(value) : updater,
			);
		},
		// Touched, always: these controls have no blur tracking of their own, and an untouched field
		// hides its error — which would silently swallow the message that says why Save did nothing.
		state: { value, meta: { isTouched: true } },
	};
}

export function FollowMeField({
	value,
	onChange,
	disabled = false,
	errors = {},
}: {
	value: FollowMeFormValues;
	onChange: (next: FollowMeFormValues) => void;
	disabled?: boolean;
	/** Client messages keyed `targets.<index>.<field>`, plus the server's own `followMe`. */
	errors?: Readonly<Record<string, string>>;
}) {
	const targets = value.targets;
	const full = targets.length >= MAX_FOLLOW_ME_TARGETS;

	function setTargets(next: readonly FollowMeTargetFormValues[]): void {
		onChange({ ...value, targets: [...next] });
	}

	function patchTarget(index: number, patch: Partial<FollowMeTargetFormValues>): void {
		setTargets(targets.map((target, at) => (at === index ? { ...target, ...patch } : target)));
	}

	return (
		<FormSection title="Follow me" description={COPY.section} columns={1}>
			<SwitchField
				field={fieldLike("followMeEnabled", value.enabled, (next) =>
					onChange({ ...value, enabled: next }),
				)}
				label="Chase calls down the ladder"
				description={COPY.enabled}
				disabled={disabled}
			/>
			<SwitchField
				field={fieldLike("followMeIgnoreBusy", value.ignoreBusy, (next) =>
					onChange({ ...value, ignoreBusy: next }),
				)}
				label="Skip rungs already on a call"
				description={COPY.ignoreBusy}
				disabled={disabled}
			/>

			{errors.followMe ? (
				<p role="alert" className="text-xs text-danger">
					{errors.followMe}
				</p>
			) : null}
			{errors.targets ? (
				<p role="alert" className="text-xs text-danger">
					{errors.targets}
				</p>
			) : null}

			{targets.length === 0 ? (
				<p className="text-xs text-muted-foreground">{COPY.empty}</p>
			) : (
				<ol className="flex flex-col gap-3">
					{targets.map((target, index) => (
						<FollowMeRow
							// The index IS the identity: a rung has no id, and two rungs may legitimately
							// dial the same number at different delays.
							key={index}
							index={index}
							last={index === targets.length - 1}
							target={target}
							disabled={disabled}
							errors={errors}
							onPatch={(patch) => patchTarget(index, patch)}
							onMove={(delta) => setTargets(moveFollowMeTarget(targets, index, delta))}
							onRemove={() => setTargets(targets.filter((_, at) => at !== index))}
						/>
					))}
				</ol>
			)}

			{value.enabled && targets.length === 0 ? (
				<p className="text-xs text-warning">
					Follow me is on with no rungs, so it changes nothing about where a call goes.
				</p>
			) : null}

			<div className="flex items-center gap-3">
				<Button
					variant="secondary"
					size="sm"
					disabled={disabled || full}
					onClick={() => setTargets([...targets, EMPTY_FOLLOW_ME_TARGET])}
				>
					Add a rung
				</Button>
				<span className="text-xs text-muted-foreground">
					{full ? COPY.full : `${targets.length} of ${MAX_FOLLOW_ME_TARGETS}.`}
				</span>
			</div>
		</FormSection>
	);
}

function FollowMeRow({
	index,
	last,
	target,
	disabled,
	errors,
	onPatch,
	onMove,
	onRemove,
}: {
	index: number;
	last: boolean;
	target: FollowMeTargetFormValues;
	disabled: boolean;
	errors: Readonly<Record<string, string>>;
	onPatch: (patch: Partial<FollowMeTargetFormValues>) => void;
	onMove: (delta: number) => void;
	onRemove: () => void;
}) {
	const label = target.destination.length > 0 ? target.destination : `rung ${index + 1}`;
	const key = (field: string): string => `targets.${index}.${field}`;

	return (
		<li className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-3">
			<div className="flex items-center gap-2">
				<span className="text-xs font-medium text-muted-foreground" data-tabular>
					{index + 1}.
				</span>
				<span className="flex-1" />
				<button
					type="button"
					disabled={disabled || index === 0}
					onClick={() => onMove(-1)}
					className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
					aria-label={`Move ${label} up`}
				>
					Up
				</button>
				<button
					type="button"
					disabled={disabled || last}
					onClick={() => onMove(1)}
					className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover disabled:opacity-40"
					aria-label={`Move ${label} down`}
				>
					Down
				</button>
				<button
					type="button"
					disabled={disabled}
					onClick={onRemove}
					className="rounded px-1.5 py-0.5 text-xs text-danger hover:bg-danger-subtle"
					aria-label={`Remove ${label}`}
				>
					Remove
				</button>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<TextField
					field={fieldLike(key("destination"), target.destination, (next) =>
						onPatch({ destination: next }),
					)}
					label="Rings"
					required
					placeholder="+12125550100"
					description={COPY.destination}
					disabled={disabled}
					submitError={errors[key("destination")]}
					className="sm:col-span-2"
				/>
				<TextField
					field={fieldLike(key("delaySeconds"), target.delaySeconds, (next) =>
						onPatch({ delaySeconds: next }),
					)}
					label="Start ringing after (seconds)"
					required
					placeholder="0"
					description={COPY.delay}
					disabled={disabled}
					submitError={errors[key("delaySeconds")]}
				/>
				<TextField
					field={fieldLike(key("timeoutSeconds"), target.timeoutSeconds, (next) =>
						onPatch({ timeoutSeconds: next }),
					)}
					label="Stop ringing after (seconds)"
					required
					placeholder="30"
					description={COPY.timeout}
					disabled={disabled}
					submitError={errors[key("timeoutSeconds")]}
				/>
			</div>

			<SwitchField
				field={fieldLike(key("confirm"), target.confirm, (next) => onPatch({ confirm: next }))}
				label="Require answer confirmation"
				description={COPY.confirm}
				disabled={disabled}
			/>
		</li>
	);
}
