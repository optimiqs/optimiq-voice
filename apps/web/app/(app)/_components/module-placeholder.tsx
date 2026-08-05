import { EmptyState } from "~/components/ui/empty-state";
import { PageHeader } from "~/components/ui/page-header";
import type { ReactNode } from "react";

/**
 * The stub every PBX module renders until its backend exists.
 *
 * The routes are real and permission-gated from day one — that is the point of shipping them
 * before the CRUD. A user with `extensions.read` can reach `/extensions` and be told, in the
 * product, what will be there; a user without it gets the same denial they will get later. When
 * P3 lands the entity, the page body is replaced and nothing about navigation, permissions or
 * links has to change.
 */
export function ModulePlaceholder({
	title,
	description,
	icon,
	whatsComing,
}: {
	title: string;
	description: string;
	icon: ReactNode;
	whatsComing: string;
}) {
	return (
		<>
			<PageHeader title={title} description={description} />
			<EmptyState icon={icon} title="Not available yet" description={whatsComing} />
		</>
	);
}
