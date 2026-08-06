"use client";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { DiagnosticList, RollbackBanner, WarningsBanner } from "~/components/pbx/warnings-banner";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardBody,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { SelectField, TextField } from "~/components/ui/form-fields";
import { toast } from "~/components/ui/toast";
import { useServerFieldErrors } from "~/lib/forms/server-errors";
import { compileRouting, simulateRouting } from "~/lib/pbx/client";
import { ROUTING_CONTEXTS } from "~/lib/pbx/contracts";
import { pbxFormMessage } from "~/lib/pbx/errors";
import { simulateFormSchema, type SimulateFormValues } from "~/lib/pbx/schemas";
import { usePermission } from "../../_context/session-context";
import type { CompileResult, RoutingContext, SimulateResult } from "~/lib/pbx/contracts";

/**
 * The two operations that are about the compiled ARTIFACT rather than about a row.
 *
 * ## Compile
 *
 * Every write already recompiles and republishes — that is what compile-on-write means, and it is
 * why an unsound save is rolled back. So this button is not "apply my changes": it is the manual
 * counterpart, for a tenant whose cache was evicted by hand or whose artifact predates a version
 * bump. Saying that plainly matters, because a "Publish" button that users believe is required
 * turns every save into a two-step ritual and every forgotten second step into a support call.
 *
 * ## Simulate
 *
 * "What happens if someone calls this number, on a Sunday, at 3am?" — the one question a
 * configuration screen cannot answer by being read. It compiles from the DATABASE rather than
 * from the cache, so its answer can never disagree with what is on screen, and `at` is explicit
 * because a simulation without a clock can only answer "what happens right now", which is exactly
 * the question someone configuring out-of-hours behaviour is not asking.
 */
export function RoutingToolsPanel() {
	const canPublish = usePermission("routes.publish");
	const canSimulate = usePermission("routes.simulate");

	return (
		<>
			{canPublish ? <CompileCard /> : null}
			{canSimulate ? <SimulateCard /> : null}
			{!canPublish && !canSimulate ? (
				<Card>
					<CardBody>
						<p className="text-sm text-muted-foreground">
							Your role does not include publishing or simulating routing. An administrator can
							change that under Settings → Members.
						</p>
					</CardBody>
				</Card>
			) : null}
		</>
	);
}

function CompileCard() {
	const [result, setResult] = useState<CompileResult | null>(null);

	const compile = useMutation({
		mutationFn: compileRouting,
		onSuccess: (data) => {
			setResult(data);
			toast.success(data.published ? "Routing recompiled and published" : "Routing recompiled", {
				description:
					data.warnings.length > 0
						? `${data.warnings.length} warning${data.warnings.length === 1 ? "" : "s"} — see the details on screen.`
						: undefined,
			});
		},
		onError: () => {
			setResult(null);
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>Recompile routing</CardTitle>
				<CardDescription>
					Every save already recompiles and republishes — a save that would produce an error is
					rolled back rather than stored. Use this to force a rebuild after a cache was cleared, or
					to see what the compiler currently thinks of the whole configuration.
				</CardDescription>
			</CardHeader>
			<CardBody className="flex flex-col gap-4">
				{compile.error ? (
					<RollbackBanner
						diagnostics={[]}
						message={pbxFormMessage(compile.error) ?? "The compile failed."}
					/>
				) : null}

				{result ? (
					<>
						<dl className="grid gap-3 sm:grid-cols-3">
							<Fact label="Snapshot" value={result.snapshotHash.slice(0, 16)} mono />
							<Fact label="Compiled" value={new Date(result.compiledAt).toLocaleString()} />
							<Fact
								label="Published to the engine"
								value={result.published ? "Yes" : "No broker reachable"}
							/>
						</dl>
						{result.warnings.length > 0 ? (
							<WarningsBanner
								title="Compiled with warnings"
								description="The artifact is live. These are configurations the compiler thinks you will want to fix."
								warnings={result.warnings}
							/>
						) : (
							<p className="text-sm text-success">No warnings. Every route resolves.</p>
						)}
					</>
				) : null}
			</CardBody>
			<CardFooter>
				<Button variant="primary" loading={compile.isPending} onClick={() => compile.mutate()}>
					Recompile now
				</Button>
			</CardFooter>
		</Card>
	);
}

const CONTEXT_LABELS: Readonly<Record<RoutingContext, string>> = {
	inbound: "A call arriving from outside",
	internal: "A call between two extensions",
	outbound: "A call being dialled out",
};

function SimulateCard() {
	const server = useServerFieldErrors();
	const [result, setResult] = useState<SimulateResult | null>(null);

	const simulate = useMutation({
		mutationFn: simulateRouting,
		onSuccess: (data) => setResult(data),
		onError: (error) => {
			setResult(null);
			server.capture(error);
		},
	});

	const form = useForm({
		defaultValues: {
			routingContext: "inbound",
			destinationNumber: "",
			callerNumber: "",
			at: "",
		} as SimulateFormValues,
		validators: { onSubmit: simulateFormSchema },
		onSubmit: async ({ value }) => {
			const parsed = simulateFormSchema.parse(value);
			server.clear();
			await simulate.mutateAsync({
				routingContext: parsed.routingContext,
				destinationNumber: parsed.destinationNumber,
				...(parsed.callerNumber === "" ? {} : { callerNumber: parsed.callerNumber }),
				// `at` is a `datetime-local` value with no zone; the API wants an ISO instant.
				...(parsed.at === "" ? {} : { at: new Date(parsed.at).toISOString() }),
			});
		},
	});

	return (
		<Card>
			<CardHeader>
				<CardTitle>What happens if someone calls…</CardTitle>
				<CardDescription>
					Resolves a number against the configuration as it is right now — compiled from the
					database, not from the cache, so this can never disagree with what you see on the other
					tabs.
				</CardDescription>
			</CardHeader>
			<form
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<CardBody className="flex flex-col gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<form.Field name="routingContext">
							{(field) => (
								<SelectField
									field={field}
									label="Kind of call"
									disabled={simulate.isPending}
									submitError={server.errors.routingContext}
								>
									{ROUTING_CONTEXTS.map((value) => (
										<option key={value} value={value}>
											{CONTEXT_LABELS[value]}
										</option>
									))}
								</SelectField>
							)}
						</form.Field>
						<form.Field name="destinationNumber">
							{(field) => (
								<TextField
									field={field}
									label="Number dialled"
									required
									placeholder="+12125550100"
									disabled={simulate.isPending}
									submitError={server.errors.destinationNumber}
								/>
							)}
						</form.Field>
						<form.Field name="callerNumber">
							{(field) => (
								<TextField
									field={field}
									label="From"
									placeholder="Optional"
									description="Lets you test routes narrowed by caller ID."
									disabled={simulate.isPending}
									submitError={server.errors.callerNumber}
								/>
							)}
						</form.Field>
						<form.Field name="at">
							{(field) => (
								<TextField
									field={field}
									label="At"
									type="text"
									placeholder="Now"
									description="An ISO instant, e.g. 2026-08-09T03:00. Leave blank for right now — time conditions are evaluated against this."
									disabled={simulate.isPending}
									submitError={server.errors.at}
								/>
							)}
						</form.Field>
					</div>

					{simulate.error && Object.keys(server.errors).length === 0 ? (
						<p
							role="alert"
							className="rounded-panel border border-danger/40 bg-danger-subtle px-3 py-2 text-sm text-foreground"
						>
							{pbxFormMessage(simulate.error)}
						</p>
					) : null}

					{result ? <SimulationResult result={result} /> : null}
				</CardBody>
				<CardFooter>
					<Button type="submit" variant="primary" loading={simulate.isPending}>
						Resolve
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

/**
 * The resolved path.
 *
 * "Did not match" is a legitimate, useful answer and gets equal billing rather than being styled
 * as an error — a number with no route is a fact about the configuration, and `reason` is the
 * resolver explaining which decision ended the search.
 */
function SimulationResult({ result }: { result: SimulateResult }) {
	return (
		<section
			aria-label="Simulation result"
			className="flex flex-col gap-3 rounded-panel border border-border bg-muted/40 px-4 py-3"
		>
			<div className="flex flex-wrap items-center gap-2">
				<Badge tone={result.matched ? "success" : "warning"}>
					{result.matched ? "Matched" : "No route matched"}
				</Badge>
				<span className="text-sm text-muted-foreground">{result.routingContext}</span>
			</div>

			<dl className="grid gap-3 sm:grid-cols-2">
				{result.matchedRuleName || result.matchedRuleId ? (
					<Fact
						label="Matched"
						value={result.matchedRuleName ?? (result.matchedRuleId as string)}
					/>
				) : null}
				{result.destinationType ? (
					<Fact
						label="Goes to"
						value={
							result.destinationRef
								? `${result.destinationType} · ${result.destinationRef.slice(0, 8)}…`
								: result.destinationType
						}
					/>
				) : null}
				{result.dialedNumber ? <Fact label="Dialled as" value={result.dialedNumber} mono /> : null}
				{result.entryNodeId ? <Fact label="Entry node" value={result.entryNodeId} mono /> : null}
			</dl>

			{result.reason ? <p className="text-sm text-muted-foreground">{result.reason}</p> : null}

			{result.diagnostics.length > 0 ? (
				<div className="flex flex-col gap-2 border-t border-border pt-3">
					<p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
						What the compiler and the resolver noticed
					</p>
					<DiagnosticList diagnostics={result.diagnostics} />
				</div>
			) : null}
		</section>
	);
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
			<dd
				className={mono ? "font-mono text-sm break-all text-foreground" : "text-sm text-foreground"}
			>
				{value}
			</dd>
		</div>
	);
}
