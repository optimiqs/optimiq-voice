import { mohClass } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Music-on-hold classes.
 *
 * ## What routing actually reads, and why the rest is still here
 *
 * `packages/routing` reads exactly one column: `name`. Every `mohClassId` in the snapshot is a row
 * id, every media server addresses a class by NAME, and the compiler's job is to resolve the first
 * into the second so the engine — which holds no database handle at call time — can hand a name to
 * the media server. The stream URI, the sample rate, the shuffle flag and the file list belong to
 * the media server's provisioning rather than to a routing decision, which is why they are absent
 * from `MohClassInput`.
 *
 * That makes the rename case the interesting one: `moh_class` IS in
 * `ROUTING_TABLE_TO_ENTITY`, so renaming a class recompiles the tenant and republishes an artifact
 * in which five node kinds now carry the new name. Nothing else about the class does — adding a
 * file to it does not, because files are `prompt` rows and `prompt` is deliberately not a routing
 * table.
 *
 * ## No destination trio, and no `destinationType`
 *
 * A hold-music class is not a place a call goes; it is an attribute of somewhere a call already is.
 * Nothing can name it as a destination, so the reverse destination scan has nothing to find — which
 * is exactly why the five foreign keys that DO point at it have to be declared as
 * {@link PbxResource.scalarReferences} instead. All five are `on delete set null`, so without this
 * the database would happily accept the delete and silently return five entities to the media
 * server's default class, which is the kind of change nobody notices until a caller mentions the
 * hold music changed.
 *
 * `prompt.moh_class_id` is deliberately NOT in that list even though it is a foreign key to this
 * table: it is `on delete cascade`, because a class's files have no meaning without the class. The
 * service deletes their objects before the row goes, so the cascade does not leave audio under the
 * mount that nothing can name.
 */
export const MOH_CLASS_RESOURCE: PbxResource = {
	kind: "moh-class",
	tableName: "moh_class",
	table: mohClass,
	searchColumns: [mohClass.name, mohClass.description],
	orderBy: [mohClass.name, mohClass.id],
	enabledColumn: mohClass.enabled,
	destinations: [],
	destinationType: null,
	scalarReferences: [
		{ table: "extension", kind: "extension", column: "moh_class_id", nameColumn: "number" },
		{ table: "ring_group", kind: "ring-group", column: "moh_class_id", nameColumn: "name" },
		{ table: "queue", kind: "queue", column: "moh_class_id", nameColumn: "name" },
		{ table: "conference", kind: "conference", column: "moh_class_id", nameColumn: "name" },
		{ table: "park_lot", kind: "park-lot", column: "moh_class_id", nameColumn: "name" },
	],
};
