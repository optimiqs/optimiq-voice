import { ModuleEffectRuntime } from "@optimiq-voice/effect-runtime";
import { PbxRepository, pbxRepositoryLayer } from "./pbx.repository";
import type { PbxRepositoryDependencies, PbxRepositoryInterface } from "./pbx.repository";

/**
 * The PBX area's Effect runtime.
 *
 * Provided under a Symbol token via `useFactory` by `pbx.module.ts` (oikos §3). `ModuleEffectRuntime`
 * implements `OnApplicationShutdown`, so Nest disposes it — and therefore runs the layer's
 * finalizers — exactly once, at shutdown. Named here so the eleven services do not each have to
 * spell the three type parameters out.
 */
export type PbxRepositoryRuntime = ModuleEffectRuntime<
	PbxRepository,
	PbxRepositoryInterface,
	never
>;

export function makePbxRepositoryRuntime(deps: PbxRepositoryDependencies): PbxRepositoryRuntime {
	return new ModuleEffectRuntime(PbxRepository, pbxRepositoryLayer(deps));
}
