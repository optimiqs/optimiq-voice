import { ExpectedTextType, StepEvaluationReport, ToolEvaluationReport } from "@optimiq-voice/types";

const EVALUATION_TYPE_TO_NUM: Record<string, number> = {
	[ExpectedTextType.EXACT]: 0,
	[ExpectedTextType.SIMILAR]: 1,
};

function toolReportToPayload(t: ToolEvaluationReport): Record<string, unknown> {
	return {
		expectedTool: t.expectedTool,
		actualTool: t.actualTool,
		passed: t.passed,
		expectedParameters: t.expectedParameters,
		actualParameters: t.actualParameters,
		errorMessage: t.errorMessage ?? "",
	};
}

/**
 * Converts StepEvaluationReport to the wire payload shape expected by the gRPC stream
 * (camelCase, evaluationType as number for proto).
 */
export function stepReportToEventPayload(
	scenarioRef: string,
	report: StepEvaluationReport,
): Record<string, unknown> {
	return {
		stepResult: {
			scenarioRef,
			report: {
				humanInput: report.humanInput,
				expectedResponse: report.expectedResponse,
				aiResponse: report.aiResponse,
				evaluationType: EVALUATION_TYPE_TO_NUM[report.evaluationType] ?? 0,
				passed: report.passed,
				errorMessage: report.errorMessage ?? "",
				toolEvaluations: (report.toolEvaluations ?? []).map(toolReportToPayload),
			},
		},
	};
}

export function scenarioSummaryToEventPayload(
	scenarioRef: string,
	overallPassed: boolean,
): Record<string, unknown> {
	return {
		scenarioSummary: {
			scenarioRef,
			overallPassed,
		},
	};
}

export function evalErrorToEventPayload(message: string): Record<string, unknown> {
	return {
		evalError: {
			message,
		},
	};
}
