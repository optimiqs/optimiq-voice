import { ivrMenu, ivrMenuOption } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * IVR menus and their options.
 *
 * The menu itself carries two optional trios — the branch taken after `maxTimeouts` silent passes
 * and the branch taken after `maxFailures` invalid entries — and each option carries a required
 * one. Options may point anywhere, including back at their own parent: the compiler warns
 * (`ivr-cycle`) rather than refusing, because a caller pressing keys makes cycles legal at
 * runtime, and errors only on an option that targets its *own* menu (`self-referencing-ivr`),
 * which can only ever loop.
 *
 * `parentId` on the menu is advisory — it renders the admin tree — and is `on delete set null`, so
 * it is not part of the reference scan.
 */
export const IVR_MENU_RESOURCE: PbxResource = {
	kind: "ivr-menu",
	tableName: "ivr_menu",
	table: ivrMenu,
	searchColumns: [ivrMenu.name, ivrMenu.extensionNumber],
	orderBy: [ivrMenu.name, ivrMenu.id],
	enabledColumn: ivrMenu.enabled,
	destinations: [
		{ prefix: "timeout", required: false },
		{ prefix: "invalid", required: false },
	],
	destinationType: "ivr",
};

export const IVR_MENU_OPTION_RESOURCE: PbxChildResource = {
	kind: "ivr-menu-option",
	tableName: "ivr_menu_option",
	table: ivrMenuOption,
	searchColumns: [],
	orderBy: [ivrMenuOption.ordinal, ivrMenuOption.id],
	enabledColumn: ivrMenuOption.enabled,
	destinations: [{ prefix: "", required: true }],
	destinationType: null,
	parentColumn: ivrMenuOption.ivrMenuId,
	parentKind: "ivr-menu",
	parentTable: ivrMenu,
};
