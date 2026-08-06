/**
 * Zod contracts for every subject on the NATS backbone.
 *
 * These schemas are the SINGLE SOURCE OF TRUTH for the wire format. The inferred TypeScript types
 * are derived from them, and the Go structs in `packages/events-go` are generated from them.
 *
 * ## Cross-language codegen (live — see `scripts/generate-go.ts`)
 *
 * `pnpm --filter @optimiq-voice/events codegen` walks the explicit registry in
 * `scripts/registry.ts`, emits JSON Schema (draft-2020-12, zod 4 `z.toJSONSchema`) into
 * `schema/`, and generates `packages/events-go/*_gen.go` plus the parity golden
 * (`testdata/parity.json`) that the Go tests byte-compare against the live TS implementation.
 * `pnpm --filter @optimiq-voice/events codegen:check` is the CI drift gate: a schema change that
 * forgets codegen fails the build, which is the whole point of "no untyped publishes".
 *
 * Adding or changing a schema therefore means: edit here, register it in `scripts/registry.ts`
 * if new, run `codegen`, and commit the regenerated `schema/` + `packages/events-go` output.
 *
 * The emitted JSON Schema stays in the repo: it is the artifact the drift check compares, and it
 * documents the contract for anyone who cannot run TypeScript.
 */

export {
	auditActorSchema,
	auditChangeSchema,
	AUDIT_EVENT_DEFINITIONS,
	AUDIT_RECORDED,
	auditEventSchema,
	auditRecordedDataSchema,
	auditResourceSchema,
	makeAuditEvent,
	type AuditEventEnvelope,
	type AuditRecordedData,
	type AuditRecordedEnvelope,
} from "./audit-events";
export {
	CALL_EVENT_DEFINITIONS,
	callEventSchema,
	channelAnsweredDataSchema,
	channelBridgedDataSchema,
	channelCreatedDataSchema,
	channelDestroyedDataSchema,
	channelDtmfDataSchema,
	channelEarlyMediaDataSchema,
	channelHangupDataSchema,
	channelHeldDataSchema,
	channelRecordStartedDataSchema,
	channelRecordStoppedDataSchema,
	channelRingingDataSchema,
	channelUnbridgedDataSchema,
	channelUnheldDataSchema,
	makeCallEvent,
	type CallEventDataOf,
	type CallEventDefinitions,
	type CallEventEnvelope,
	type CallEventInput,
	type CallEventOf,
} from "./call-events";
export {
	CDR_EVENT_DEFINITIONS,
	CDR_LEG_WRITE,
	cdrEventSchema,
	cdrLegWriteDataSchema,
	makeCdrLegWriteEvent,
	type CdrEventEnvelope,
	type CdrLegWriteData,
	type CdrLegWriteEnvelope,
} from "./cdr-events";
export {
	baseEventEnvelopeSchema,
	defineEvent,
	entityIdSchema,
	EVENT_ENVELOPE_MAJOR,
	eventInstantSchema,
	eventSourceSchema,
	makeEvent,
	type AnyEventDefinition,
	type BaseEventEnvelope,
	type DataOf,
	type EventDefinition,
	type EventInput,
	type EventOf,
} from "./envelope";
export {
	deviceRejectedDataSchema,
	deviceRenderedDataSchema,
	deviceRequestedDataSchema,
	makeProvisionEvent,
	PROVISION_EVENT_DEFINITIONS,
	PROVISION_EVENTS,
	provisionEventSchema,
	type ProvisionEvent,
	type ProvisionEventDataOf,
	type ProvisionEventDefinitions,
	type ProvisionEventEnvelope,
	type ProvisionEventInput,
	type ProvisionEventOf,
} from "./provision-events";
export {
	makeQueueEvent,
	QUEUE_EVENT_DEFINITIONS,
	queueAgentStateDataSchema,
	queueCallerAbandonedDataSchema,
	queueCallerAnsweredDataSchema,
	queueCallerJoinedDataSchema,
	queueEventSchema,
	type QueueEventDataOf,
	type QueueEventDefinitions,
	type QueueEventEnvelope,
	type QueueEventInput,
	type QueueEventOf,
} from "./queue-events";
export {
	aorSchema,
	contactSchema,
	makeRegistrationEvent,
	REGISTRATION_EVENT_DEFINITIONS,
	registrationEventSchema,
	registrationExpiredDataSchema,
	registrationRegisteredDataSchema,
	registrationUnregisteredDataSchema,
	type RegistrationEventDataOf,
	type RegistrationEventDefinitions,
	type RegistrationEventEnvelope,
	type RegistrationEventInput,
	type RegistrationEventOf,
} from "./registration-events";
export {
	AUTHZ_CHECK_RPC,
	authzCheckRequestSchema,
	authzCheckResponseSchema,
	ROUTING_RESOLVE_RPC,
	routingResolveRequestSchema,
	routingResolveResponseSchema,
	RPC_CONTRACTS,
	type AuthzCheckRequest,
	type AuthzCheckResponse,
	type RoutingResolveRequest,
	type RoutingResolveResponse,
	type RpcContract,
} from "./rpc";
export {
	AGENT_STATUSES,
	agentStatusSchema,
	BRIDGE_MODES,
	bridgeModeSchema,
	CALL_DIRECTIONS,
	callDirectionSchema,
	destinationTypeSchema,
	dialStringSchema,
	dispositionSchema,
	DTMF_SOURCES,
	dtmfDigitSchema,
	dtmfSourceSchema,
	HANGUP_SIDES,
	hangupCauseCodeSchema,
	hangupCauseSchema,
	hangupSideSchema,
	LEG_SIDES,
	legSideSchema,
	macAddressSchema,
	RECORDING_KINDS,
	RECORDING_STOP_REASONS,
	recordingKindSchema,
	recordingStopReasonSchema,
	SIP_TRANSPORTS,
	sipTransportSchema,
	type AgentStatus,
	type BridgeMode,
	type CallDirection,
	type DtmfSource,
	type HangupSide,
	type LegSide,
	type RecordingKind,
	type RecordingStopReason,
	type SipTransport,
} from "./telephony";
