"use client";

import { useQuery } from "@tanstack/react-query";
import { useActiveOrganization } from "~/app/(app)/_context/session-context";
import { listPbx, type PbxResourceDescriptor } from "~/lib/pbx/client";
import { queryKeys } from "~/lib/query-keys";
import { Badge } from "../ui/badge";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import type { ReactNode } from "react";

/**
 * A foreign key the API will not let this app write, rendered as a fact.
 *
 * ## Why this exists rather than a picker
 *
 * Three columns landed with the T2 admin block that the compiler reads and no request body may
 * carry: `outbound_route.pin_set_id`, `outbound_route.translation_ruleset_id` and
 * `trunk.inbound_translation_ruleset_id`. Every write DTO in `apps/api/src/pbx` is a
 * `z.strictObject`, and none of the three declares these — so a select wired to one would produce a
 * 400 naming a field the user had just chosen from a list this app rendered.
 *
 * The alternative to this component is showing nothing, and that is worse in the specific way that
 * matters here: an outbound route silently gated by a PIN set, or a trunk silently rewriting every
 * caller id that arrives on it, is exactly the configuration somebody opens a form to understand. A
 * form that omitted it would be actively misleading — the reader would conclude the route is
 * ungated because the dialog showed them every field it had.
 *
 * So the attachment is rendered, named, and labelled as not editable here. When a DTO declares the
 * column, this becomes a `ResourceSelect` and the note goes; nothing else about the form changes.
 *
 * ## The list is capped and unsearched, deliberately
 *
 * It exists only to turn one id into one name, so it reads the same page-of-100 every picker on the
 * form already has cached. An id outside that page renders as a short id rather than as a blank,
 * which is the honest answer — "there is something attached and this screen cannot name it" is a
 * different fact from "nothing is attached".
 */
export function AttachedReference<TRow extends { readonly id: string }>({
	label,
	description,
	resource,
	value,
	emptyLabel,
	note,
}: {
	label: string;
	description?: ReactNode;
	resource: PbxResourceDescriptor<TRow>;
	value: string | null;
	/** What to say when nothing is attached — usually the more interesting of the two states. */
	emptyLabel: string;
	/** Why this cannot be changed here. Rendered whether or not anything is attached. */
	note: ReactNode;
}) {
	const organizationId = useActiveOrganization()?.id ?? "";

	const query = useQuery({
		queryKey: queryKeys.pbxList(organizationId, resource.key, {
			page: 1,
			limit: 100,
			search: null,
			enabled: null,
			purpose: "attached-reference",
		}),
		queryFn: () => listPbx(resource, { page: 1, limit: 100 }),
		enabled: organizationId.length > 0 && value !== null,
	});

	const row = query.data?.data.find((candidate) => candidate.id === value);
	const name =
		value === null
			? null
			: row
				? resource.displayName(row)
				: query.isPending
					? "Loading…"
					: `${value.slice(0, 8)}…`;

	return (
		<Field name={`attached-${resource.key}`} className="sm:col-span-2">
			<FieldLabel>{label}</FieldLabel>
			<p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
				{name === null ? (
					<span className="text-muted-foreground">{emptyLabel}</span>
				) : (
					<>
						<Badge tone="accent">{resource.label}</Badge>
						<span>{name}</span>
					</>
				)}
			</p>
			{description ? <FieldDescription>{description}</FieldDescription> : null}
			<FieldDescription>{note}</FieldDescription>
		</Field>
	);
}
