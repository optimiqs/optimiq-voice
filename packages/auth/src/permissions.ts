/**
 * The Optimiq Voice permission registry — the single source of truth for authorization.
 *
 * FusionPBX carried ~940 field-level permissions; this collapses them to a
 * `<resource>.<action>[.<scope>]` model. `resource` and `action` are kebab-case; `scope` is
 * drawn from a closed set and narrows a permission to a subset of the organization's rows:
 *
 * - no scope — organization-wide
 * - `own`    — only rows the acting user owns (their extension, their voicemail, their calls)
 * - `team`   — rows belonging to a team/queue the user is a member of (reserved for T2 ACD)
 * - `all`    — crosses the organization boundary; platform-operator surface only
 *
 * `apps/api` consumes this through a `@RequirePermissions(...)` guard, and a sync-permissions
 * codegen step mirrors it into the web app (the oikos cross-repo contract bridge). Adding a
 * permission here is the only supported way to introduce one.
 */

export const PERMISSION_SCOPES = ["own", "team", "all"] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/** Every permission string must match this shape; enforced by spec. */
export const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.(?:own|team|all))?$/u;

export const PERMISSIONS = [
	// --- Telephony inventory -------------------------------------------------
	"extensions.read",
	"extensions.read.own",
	"extensions.write",
	"extensions.write.own",
	"extensions.delete",
	"extensions.assign",

	"devices.read",
	"devices.read.own",
	"devices.write",
	"devices.delete",
	"devices.reboot",

	"numbers.read",
	"numbers.write",
	/**
	 * Buying a DID from the managed carrier.
	 *
	 * Split from `numbers.write` because the two differ in the only way that matters here: writing
	 * changes how a number the organization already owns behaves, ordering **spends the
	 * organization's money on a recurring commitment**. A manager who may re-point a DID at a
	 * different IVR should not, by that fact alone, be able to add a line to the monthly bill. It
	 * is the sharpest boundary in the carrier feature, and the only one that earned its own entry —
	 * see the header of `apps/api/src/pbx/carrier/carrier.module.ts` for why release and trunk
	 * provisioning deliberately did not.
	 */
	"numbers.order",
	"numbers.delete",
	"numbers.assign",
	"numbers.emergency",

	"trunks.read",
	"trunks.write",
	"trunks.delete",
	"trunks.test",

	// --- Routing -------------------------------------------------------------
	"routes.read",
	"routes.write",
	"routes.delete",
	"routes.publish",
	"routes.simulate",

	"time-conditions.read",
	"time-conditions.write",
	"time-conditions.delete",

	"feature-codes.read",
	"feature-codes.write",
	"feature-codes.delete",

	// --- Call features -------------------------------------------------------
	"ivr.read",
	"ivr.write",
	"ivr.delete",
	"ivr.publish",

	"ring-groups.read",
	"ring-groups.write",
	"ring-groups.delete",

	"queues.read",
	"queues.write",
	"queues.delete",
	"queues.manage-agents",
	"queues.monitor",
	"queues.join",
	"queues.join.own",

	"voicemail.read",
	"voicemail.read.own",
	"voicemail.write",
	"voicemail.delete",
	"voicemail.delete.own",
	"voicemail.listen",
	"voicemail.listen.own",

	"conferences.read",
	"conferences.write",
	"conferences.delete",
	"conferences.moderate",

	"park-lots.read",
	"park-lots.write",
	"park-lots.delete",

	// --- Media, reporting and audit -----------------------------------------
	"recordings.read",
	"recordings.read.own",
	"recordings.download",
	"recordings.delete",
	"recordings.configure",

	"cdr.read",
	"cdr.read.own",
	"cdr.export",

	// --- Platform and tenancy ------------------------------------------------
	"settings.read",
	"settings.write",
	"settings.write.all",

	"members.read",
	"members.invite",
	"members.update-role",
	"members.remove",

	"api-keys.read",
	"api-keys.read.own",
	"api-keys.write",
	"api-keys.write.own",
	"api-keys.revoke",

	"provisioning.read",
	"provisioning.write",
	"provisioning.templates",
	"provisioning.tokens",

	"applications.read",
	"applications.write",
	"applications.delete",
	"applications.deploy",

	"secrets.read",
	"secrets.rotate",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
	return PERMISSION_SET.has(value);
}

export interface PermissionDescriptor {
	readonly permission: Permission;
	readonly label: string;
	readonly description: string;
}

export interface PermissionGroup {
	readonly resource: string;
	readonly label: string;
	readonly description: string;
	readonly permissions: readonly PermissionDescriptor[];
}

/**
 * Grouped, human-labelled view of {@link PERMISSIONS}. Drives the role editor UI and the
 * generated web-app contract. A spec asserts it covers every permission exactly once.
 */
export const PERMISSION_CATALOG: readonly PermissionGroup[] = [
	{
		resource: "extensions",
		label: "Extensions",
		description: "Internal endpoints, their dialling behaviour and their user assignment.",
		permissions: [
			{
				permission: "extensions.read",
				label: "View extensions",
				description: "List and inspect every extension in the organization.",
			},
			{
				permission: "extensions.read.own",
				label: "View own extension",
				description: "Inspect only the extensions assigned to the acting user.",
			},
			{
				permission: "extensions.write",
				label: "Manage extensions",
				description: "Create and edit any extension, including routing and voicemail options.",
			},
			{
				permission: "extensions.write.own",
				label: "Edit own extension",
				description: "Change forwarding, do-not-disturb and follow-me on own extensions.",
			},
			{
				permission: "extensions.delete",
				label: "Delete extensions",
				description: "Permanently remove an extension and detach its devices.",
			},
			{
				permission: "extensions.assign",
				label: "Assign extensions",
				description: "Bind an extension to a member or release it.",
			},
		],
	},
	{
		resource: "devices",
		label: "Devices",
		description: "Desk phones and softphones, their lines and their programmable keys.",
		permissions: [
			{
				permission: "devices.read",
				label: "View devices",
				description: "List every registered and provisioned device.",
			},
			{
				permission: "devices.read.own",
				label: "View own devices",
				description: "Inspect only devices bound to the acting user's extensions.",
			},
			{
				permission: "devices.write",
				label: "Manage devices",
				description: "Create and edit devices, lines and key layouts.",
			},
			{
				permission: "devices.delete",
				label: "Delete devices",
				description: "Remove a device and revoke its provisioning credentials.",
			},
			{
				permission: "devices.reboot",
				label: "Reboot devices",
				description: "Send a remote reboot or resync request to a device.",
			},
		],
	},
	{
		resource: "numbers",
		label: "Numbers",
		description: "DIDs, their inbound treatment and their emergency dispatch location.",
		permissions: [
			{
				permission: "numbers.read",
				label: "View numbers",
				description: "List DIDs and their current routing.",
			},
			{
				permission: "numbers.write",
				label: "Manage numbers",
				description: "Create, edit and re-route DIDs, including caller-ID overrides.",
			},
			{
				permission: "numbers.order",
				label: "Order numbers",
				description:
					"Buy a new DID from the connected carrier. Creates a recurring charge on the organization's account.",
			},
			{
				permission: "numbers.delete",
				label: "Delete numbers",
				description:
					"Release a DID from the organization, and from the carrier when the platform ordered it.",
			},
			{
				permission: "numbers.assign",
				label: "Assign numbers",
				description: "Point a DID at an extension, ring group, IVR or queue.",
			},
			{
				permission: "numbers.emergency",
				label: "Manage emergency routing",
				description:
					"Set the dispatchable location and notification policy (Kari's Law / RAY BAUM'S).",
			},
		],
	},
	{
		resource: "trunks",
		label: "Trunks",
		description: "Carrier connections, registrations and their credentials.",
		permissions: [
			{
				permission: "trunks.read",
				label: "View trunks",
				description: "List carriers and their registration state.",
			},
			{
				permission: "trunks.write",
				label: "Manage trunks",
				description: "Create and edit carrier connections, codecs and channel caps.",
			},
			{
				permission: "trunks.delete",
				label: "Delete trunks",
				description: "Remove a carrier connection.",
			},
			{
				permission: "trunks.test",
				label: "Test trunks",
				description: "Force a re-registration or place a diagnostic call over a trunk.",
			},
		],
	},
	{
		resource: "routes",
		label: "Routing",
		description: "Inbound and outbound routes, dial patterns, time conditions and feature codes.",
		permissions: [
			{
				permission: "routes.read",
				label: "View routing",
				description: "Inspect inbound and outbound routes and their conditions.",
			},
			{
				permission: "routes.write",
				label: "Manage routing",
				description: "Create and edit routes, dial patterns, toll classes and time conditions.",
			},
			{
				permission: "routes.delete",
				label: "Delete routes",
				description: "Remove a route from the routing model.",
			},
			{
				permission: "routes.publish",
				label: "Publish routing",
				description: "Compile the routing model and invalidate the runtime routing cache.",
			},
			{
				permission: "routes.simulate",
				label: "Simulate routing",
				description: "Trace how a number would be routed without placing a call.",
			},
		],
	},
	{
		resource: "time-conditions",
		label: "Time conditions",
		description: "Business-hours and holiday schedules, and the branches they gate.",
		permissions: [
			{
				permission: "time-conditions.read",
				label: "View time conditions",
				description: "Inspect schedules, their rules and where each branch goes.",
			},
			{
				permission: "time-conditions.write",
				label: "Manage time conditions",
				description: "Create and edit schedules, rules, timezones and no-match branches.",
			},
			{
				permission: "time-conditions.delete",
				label: "Delete time conditions",
				description: "Remove a schedule once no route gates on it.",
			},
		],
	},
	{
		resource: "feature-codes",
		label: "Feature codes",
		description: "The star-code catalogue dialled from a handset.",
		permissions: [
			{
				permission: "feature-codes.read",
				label: "View feature codes",
				description: "List the star codes and the action each one runs.",
			},
			{
				permission: "feature-codes.write",
				label: "Manage feature codes",
				description: "Create and edit star codes, their actions and their parameters.",
			},
			{
				permission: "feature-codes.delete",
				label: "Delete feature codes",
				description: "Remove a star code from the dial plan.",
			},
		],
	},
	{
		resource: "ivr",
		label: "IVR menus",
		description: "Auto-attendant menus, prompts and their nested options.",
		permissions: [
			{
				permission: "ivr.read",
				label: "View IVR menus",
				description: "Inspect menus, options and prompts.",
			},
			{
				permission: "ivr.write",
				label: "Manage IVR menus",
				description: "Create and edit menus, digit options and greetings.",
			},
			{
				permission: "ivr.delete",
				label: "Delete IVR menus",
				description: "Remove a menu and detach it from routes.",
			},
			{
				permission: "ivr.publish",
				label: "Publish IVR menus",
				description: "Compile menu changes into the runtime routing model.",
			},
		],
	},
	{
		resource: "ring-groups",
		label: "Ring groups",
		description: "Simultaneous, sequential and rollover hunt groups.",
		permissions: [
			{
				permission: "ring-groups.read",
				label: "View ring groups",
				description: "Inspect groups, members and strategies.",
			},
			{
				permission: "ring-groups.write",
				label: "Manage ring groups",
				description: "Create and edit groups, destinations, delays and timeout actions.",
			},
			{
				permission: "ring-groups.delete",
				label: "Delete ring groups",
				description: "Remove a ring group.",
			},
		],
	},
	{
		resource: "queues",
		label: "Queues",
		description: "Call queues, agents, tiers and live queue state.",
		permissions: [
			{
				permission: "queues.read",
				label: "View queues",
				description: "Inspect queues, strategies and tier configuration.",
			},
			{
				permission: "queues.write",
				label: "Manage queues",
				description: "Create and edit queues, announcements and overflow behaviour.",
			},
			{
				permission: "queues.delete",
				label: "Delete queues",
				description: "Remove a queue.",
			},
			{
				permission: "queues.manage-agents",
				label: "Manage agents",
				description: "Assign agents to tiers and force agent state changes.",
			},
			{
				permission: "queues.monitor",
				label: "Monitor queues",
				description: "Watch live queue and agent state on the wallboard.",
			},
			{
				permission: "queues.join",
				label: "Set agent availability",
				description: "Log any agent into or out of a queue.",
			},
			{
				permission: "queues.join.own",
				label: "Join and leave queues",
				description: "Set own agent availability in queues the user belongs to.",
			},
		],
	},
	{
		resource: "voicemail",
		label: "Voicemail",
		description: "Mailboxes, greetings, messages and message-waiting indication.",
		permissions: [
			{
				permission: "voicemail.read",
				label: "View mailboxes",
				description: "Inspect every mailbox and its configuration.",
			},
			{
				permission: "voicemail.read.own",
				label: "View own mailbox",
				description: "Inspect only mailboxes belonging to the acting user.",
			},
			{
				permission: "voicemail.write",
				label: "Manage mailboxes",
				description: "Create and edit mailboxes, greetings and delivery options.",
			},
			{
				permission: "voicemail.delete",
				label: "Delete messages",
				description: "Delete messages from any mailbox in the organization.",
			},
			{
				permission: "voicemail.delete.own",
				label: "Delete own messages",
				description: "Delete messages from own mailboxes.",
			},
			{
				permission: "voicemail.listen",
				label: "Listen to messages",
				description: "Play or download messages from any mailbox.",
			},
			{
				permission: "voicemail.listen.own",
				label: "Listen to own messages",
				description: "Play or download messages from own mailboxes.",
			},
		],
	},
	{
		resource: "conferences",
		label: "Conferences",
		description: "Conference rooms, PINs and in-conference moderation.",
		permissions: [
			{
				permission: "conferences.read",
				label: "View conferences",
				description: "Inspect rooms and their participants.",
			},
			{
				permission: "conferences.write",
				label: "Manage conferences",
				description: "Create and edit rooms, PINs and profiles.",
			},
			{
				permission: "conferences.delete",
				label: "Delete conferences",
				description: "Remove a conference room.",
			},
			{
				permission: "conferences.moderate",
				label: "Moderate conferences",
				description: "Mute, kick, lock and record a live conference.",
			},
		],
	},
	{
		resource: "park-lots",
		label: "Park lots",
		description: "Call-park orbits, their slot ranges and their retrieval timeout.",
		permissions: [
			{
				permission: "park-lots.read",
				label: "View park lots",
				description: "Inspect park orbits and the slots they occupy.",
			},
			{
				permission: "park-lots.write",
				label: "Manage park lots",
				description: "Create and edit park orbits, slot ranges and timeout behaviour.",
			},
			{
				permission: "park-lots.delete",
				label: "Delete park lots",
				description: "Remove a park orbit.",
			},
		],
	},
	{
		resource: "recordings",
		label: "Recordings",
		description: "Call recordings, their retention policy and their media.",
		permissions: [
			{
				permission: "recordings.read",
				label: "View recordings",
				description: "List recordings across the organization.",
			},
			{
				permission: "recordings.read.own",
				label: "View own recordings",
				description: "List only recordings of calls the acting user took part in.",
			},
			{
				permission: "recordings.download",
				label: "Download recordings",
				description: "Obtain a signed URL for recorded media.",
			},
			{
				permission: "recordings.delete",
				label: "Delete recordings",
				description: "Permanently remove recorded media.",
			},
			{
				permission: "recordings.configure",
				label: "Configure recording policy",
				description: "Set always-on, on-demand, pause-and-mask and retention rules.",
			},
		],
	},
	{
		resource: "cdr",
		label: "Call detail records",
		description: "Per-leg call history and reporting exports.",
		permissions: [
			{
				permission: "cdr.read",
				label: "View call history",
				description: "Search every call detail record in the organization.",
			},
			{
				permission: "cdr.read.own",
				label: "View own call history",
				description: "Search only records for calls the acting user took part in.",
			},
			{
				permission: "cdr.export",
				label: "Export call history",
				description: "Generate CSV or scheduled reporting exports.",
			},
		],
	},
	{
		resource: "settings",
		label: "Settings",
		description: "The organization settings cascade and platform defaults.",
		permissions: [
			{
				permission: "settings.read",
				label: "View settings",
				description: "Read organization settings and their effective values.",
			},
			{
				permission: "settings.write",
				label: "Manage settings",
				description: "Override organization-level settings.",
			},
			{
				permission: "settings.write.all",
				label: "Manage platform defaults",
				description: "Change defaults that apply to every organization. Platform operators only.",
			},
		],
	},
	{
		resource: "members",
		label: "Members",
		description: "Organization membership, invitations and role assignment.",
		permissions: [
			{
				permission: "members.read",
				label: "View members",
				description: "List members and pending invitations.",
			},
			{
				permission: "members.invite",
				label: "Invite members",
				description: "Send and resend organization invitations.",
			},
			{
				permission: "members.update-role",
				label: "Change member roles",
				description: "Move a member between roles.",
			},
			{
				permission: "members.remove",
				label: "Remove members",
				description: "Revoke a member's access to the organization.",
			},
		],
	},
	{
		resource: "api-keys",
		label: "API keys",
		description: "Programmatic credentials scoped to the organization.",
		permissions: [
			{
				permission: "api-keys.read",
				label: "View API keys",
				description: "List every API key issued for the organization.",
			},
			{
				permission: "api-keys.read.own",
				label: "View own API keys",
				description: "List only keys the acting user created.",
			},
			{
				permission: "api-keys.write",
				label: "Create API keys",
				description: "Issue keys with any permission subset the issuer holds.",
			},
			{
				permission: "api-keys.write.own",
				label: "Create own API keys",
				description: "Issue personal keys limited to the acting user's own permissions.",
			},
			{
				permission: "api-keys.revoke",
				label: "Revoke API keys",
				description: "Disable or delete an issued key.",
			},
		],
	},
	{
		resource: "provisioning",
		label: "Provisioning",
		description: "Device configuration templates and the authenticated provisioning endpoint.",
		permissions: [
			{
				permission: "provisioning.read",
				label: "View provisioning",
				description: "Inspect vendor catalogues and rendered device configuration.",
			},
			{
				permission: "provisioning.write",
				label: "Manage provisioning",
				description: "Edit provisioning settings and device profiles.",
			},
			{
				permission: "provisioning.templates",
				label: "Manage templates",
				description: "Create and edit vendor configuration templates.",
			},
			{
				permission: "provisioning.tokens",
				label: "Manage provisioning tokens",
				description: "Issue and revoke the per-device tokens that authenticate config pulls.",
			},
		],
	},
	{
		resource: "applications",
		label: "Voice applications",
		description: "Programmable voice applications and AI assistants attached to routes.",
		permissions: [
			{
				permission: "applications.read",
				label: "View applications",
				description: "List voice applications and their configuration.",
			},
			{
				permission: "applications.write",
				label: "Manage applications",
				description: "Create and edit voice applications and assistant definitions.",
			},
			{
				permission: "applications.delete",
				label: "Delete applications",
				description: "Remove a voice application.",
			},
			{
				permission: "applications.deploy",
				label: "Deploy applications",
				description: "Point live traffic at an application version.",
			},
		],
	},
	{
		resource: "secrets",
		label: "Secrets",
		description: "SIP credentials, carrier passwords and integration secrets.",
		permissions: [
			{
				permission: "secrets.read",
				label: "Reveal secrets",
				description: "Read stored SIP and integration secrets in clear text.",
			},
			{
				permission: "secrets.rotate",
				label: "Rotate secrets",
				description: "Regenerate a stored secret and invalidate the previous value.",
			},
		],
	},
];

/** Role templates seeded for every organization. Keys map to better-auth membership roles. */
export const SYSTEM_ROLE_IDS = ["owner", "admin", "manager", "user", "agent"] as const;
export type SystemRoleId = (typeof SYSTEM_ROLE_IDS)[number];

export interface SystemRoleTemplate {
	readonly id: SystemRoleId;
	readonly label: string;
	readonly description: string;
	/** The better-auth organization membership role this template is stored as. */
	readonly membershipRole: "owner" | "admin" | "member";
	readonly permissions: readonly Permission[];
}

const SELF_SERVICE_PERMISSIONS = [
	"extensions.read.own",
	"extensions.write.own",
	"devices.read.own",
	"voicemail.read.own",
	"voicemail.delete.own",
	"voicemail.listen.own",
	"recordings.read.own",
	"cdr.read.own",
	"api-keys.read.own",
	"api-keys.write.own",
	"settings.read",
] as const satisfies readonly Permission[];

const AGENT_PERMISSIONS = [
	...SELF_SERVICE_PERMISSIONS,
	"queues.read",
	"queues.join.own",
	"queues.monitor",
	"conferences.read",
	// An agent parks calls with `*5`, so the lot list has to be readable to render where a call went.
	"park-lots.read",
] as const satisfies readonly Permission[];

const MANAGER_PERMISSIONS = [
	...AGENT_PERMISSIONS,
	"extensions.read",
	"extensions.write",
	"extensions.assign",
	"devices.read",
	"devices.write",
	"devices.reboot",
	"numbers.read",
	"numbers.assign",
	"routes.read",
	"routes.simulate",
	"time-conditions.read",
	"time-conditions.write",
	"feature-codes.read",
	"feature-codes.write",
	"ivr.read",
	"ivr.write",
	"ivr.publish",
	"ring-groups.read",
	"ring-groups.write",
	"queues.write",
	"queues.manage-agents",
	"voicemail.read",
	"voicemail.write",
	"voicemail.listen",
	"conferences.write",
	"conferences.moderate",
	"park-lots.write",
	"recordings.read",
	"recordings.download",
	"cdr.read",
	"cdr.export",
	"members.read",
	"applications.read",
] as const satisfies readonly Permission[];

/** Everything except the cross-organization platform scope. */
const ADMIN_PERMISSIONS = PERMISSIONS.filter(
	(permission) => permission !== "settings.write.all",
) as readonly Permission[];

export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = [
	{
		id: "owner",
		label: "Owner",
		description:
			"Full control of the organization, including billing-adjacent settings and secrets. Cannot be removed by other members.",
		membershipRole: "owner",
		permissions: PERMISSIONS,
	},
	{
		id: "admin",
		label: "Administrator",
		description:
			"Full control of the organization's telephony, members and credentials. Cannot change platform-wide defaults.",
		membershipRole: "admin",
		permissions: ADMIN_PERMISSIONS,
	},
	{
		id: "manager",
		label: "Manager",
		description:
			"Runs the day-to-day phone system: extensions, devices, menus, groups, queues and reporting. No carrier, secret or provisioning-credential access.",
		membershipRole: "member",
		permissions: [...new Set(MANAGER_PERMISSIONS)],
	},
	{
		id: "agent",
		label: "Agent",
		description:
			"A queue agent: manages their own extension and voicemail and controls their own queue availability.",
		membershipRole: "member",
		permissions: [...new Set(AGENT_PERMISSIONS)],
	},
	{
		id: "user",
		label: "User",
		description: "An end user with access to their own extension, voicemail, devices and calls.",
		membershipRole: "member",
		permissions: [...SELF_SERVICE_PERMISSIONS],
	},
];

export function getSystemRoleTemplate(roleId: SystemRoleId): SystemRoleTemplate {
	const template = SYSTEM_ROLE_TEMPLATES.find((candidate) => candidate.id === roleId);
	if (!template) {
		throw new UnknownPermissionError(`Unknown system role template "${roleId}".`);
	}
	return template;
}

/** Raised when a permission or role identifier that is not in the registry is referenced. */
export class UnknownPermissionError extends Error {
	readonly _tag = "UnknownPermissionError" as const;

	constructor(message: string) {
		super(message);
		this.name = "UnknownPermissionError";
	}
}

export function parsePermission(value: string): {
	resource: string;
	action: string;
	scope?: PermissionScope;
} {
	if (!isPermission(value)) {
		throw new UnknownPermissionError(`"${value}" is not a registered permission.`);
	}
	const [resource, action, scope] = value.split(".") as [string, string, PermissionScope?];
	return scope === undefined ? { resource, action } : { resource, action, scope };
}

/**
 * Reshapes the flat registry into better-auth's access-control statement form
 * (`{ resource: ["action", "action.scope"] }`). Kept dependency-free so the registry can be
 * consumed by the web app codegen without pulling better-auth into the browser bundle.
 */
export function buildAccessControlStatements(
	permissions: readonly Permission[] = PERMISSIONS,
): Record<string, string[]> {
	const statements: Record<string, string[]> = {};
	for (const permission of permissions) {
		const [resource, ...rest] = permission.split(".");
		if (resource === undefined) continue;
		(statements[resource] ??= []).push(rest.join("."));
	}
	return statements;
}

/** True when `granted` satisfies `required`, treating an unscoped grant as covering its scopes. */
export function hasPermission(granted: Iterable<string>, required: Permission): boolean {
	const grantedSet = granted instanceof Set ? granted : new Set(granted);
	if (grantedSet.has(required)) {
		return true;
	}
	const { resource, action, scope } = parsePermission(required);
	return scope !== undefined && grantedSet.has(`${resource}.${action}`);
}
