import { BaseApiObject, ListRequest, ListResponse } from "./common";
import { Flatten } from "./utils";

enum ApplicationType {
  EXTERNAL = "EXTERNAL",
  AUTOPILOT = "AUTOPILOT"
}

enum ExpectedTextType {
  EXACT = "EXACT",
  SIMILAR = "SIMILAR"
}

type Application = {
  ref: string;
  name: string;
  type: ApplicationType;
  endpoint?: string;
  textToSpeech?: {
    productRef: string;
    config: Record<string, unknown>;
  };
  speechToText?: {
    productRef: string;
    config: Record<string, unknown>;
  };
  intelligence?: {
    productRef: string;
    config: Record<string, unknown>;
  };
  createdAt: Date;
  updatedAt: Date;
};

type CreateApplicationRequest = {
  name: string;
  type: ApplicationType;
  endpoint?: string;
  textToSpeech?: {
    productRef: string;
    config: Record<string, unknown>;
  };
  speechToText?: {
    productRef: string;
    config: Record<string, unknown>;
  };
  intelligence?: {
    productRef: string;
    credentials: Record<string, unknown>;
    config: Record<string, unknown>;
  };
};

type UpdateApplicationRequest = Flatten<
  BaseApiObject & Partial<CreateApplicationRequest>
>;

type ListApplicationsRequest = ListRequest;

type ListApplicationsResponse = ListResponse<Application>;

type EvaluateIntelligenceRequest = {
  intelligence: {
    productRef: string;
    config: Record<string, unknown>;
  };
};

/** Streaming event: one step result for a scenario */
type StepEvaluationResultEvent = {
  type: "stepResult";
  scenarioRef: string;
  stepResult: StepEvaluationReport;
};

/** Streaming event: scenario completed summary */
type ScenarioSummaryEvent = {
  type: "scenarioSummary";
  scenarioRef: string;
  overallPassed: boolean;
};

/** Streaming event: eval error */
type EvalErrorEvent = {
  type: "evalError";
  message: string;
};

/** Single event in the EvaluateIntelligence server stream */
type EvaluateIntelligenceEvent =
  | StepEvaluationResultEvent
  | ScenarioSummaryEvent
  | EvalErrorEvent;

type ScenarioEvaluationReport = {
  scenarioRef: string;
  overallPassed: boolean;
  steps: StepEvaluationReport[];
};

type StepEvaluationReport = {
  humanInput: string;
  expectedResponse: string;
  aiResponse: string;
  evaluationType: ExpectedTextType;
  passed: boolean;
  errorMessage?: string;
  toolEvaluations?: ToolEvaluationReport[];
};

type ToolEvaluationReport = {
  expectedTool: string;
  actualTool: string;
  passed: boolean;
  expectedParameters?: Record<string, unknown>;
  actualParameters?: Record<string, unknown>;
  errorMessage?: string;
};

type CreateTestTokenResponse = {
  domain: string;
  displayName: string;
  signalingServer: string;
  targetAor: string;
  username: string;
  token: string;
};

export {
  Application,
  ApplicationType,
  CreateApplicationRequest,
  CreateTestTokenResponse,
  ListApplicationsRequest,
  ListApplicationsResponse,
  UpdateApplicationRequest,
  EvaluateIntelligenceRequest,
  EvaluateIntelligenceEvent,
  ScenarioEvaluationReport,
  StepEvaluationReport,
  ToolEvaluationReport,
  ExpectedTextType
};
