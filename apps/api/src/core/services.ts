import { buildIdentityService } from "@optimiq-voice/identity";
import {
	buildAclsService,
	buildAgentsService,
	buildCredentialsService,
	buildDomainsService,
	buildNumbersService,
	buildTrunksService,
} from "@optimiq-voice/sipnet";
import { buildApplicationsService } from "../applications";
import { buildCallsService } from "../calls";
import { influxdb } from "../calls/influxdb";
import { buildSecretsService } from "../secrets";
import { createCheckNumberPreconditions } from "../utils";
import { buildWelcomeDemoService } from "./buildWelcomeDemoService";
import { db } from "./db";
import { identityConfig } from "./identityConfig";
import { routrConfig } from "./routrConfig";
import { testTokenConfig } from "./testTokenConfig";

const applicationsService = buildApplicationsService(db, testTokenConfig);
const secretsService = buildSecretsService(db);
const callsService = buildCallsService(influxdb);
const identityService = buildIdentityService(identityConfig);
const agentsService = buildAgentsService(routrConfig);
const domainsService = buildDomainsService(routrConfig);
const credentialsService = buildCredentialsService(routrConfig);
const trunksService = buildTrunksService(routrConfig);
const numbersService = buildNumbersService(routrConfig, createCheckNumberPreconditions(db));
const aclsService = buildAclsService(routrConfig);
const welcomeDemoService = buildWelcomeDemoService();

const services = Promise.all([
	applicationsService,
	secretsService,
	callsService,
	identityService,
	agentsService,
	credentialsService,
	aclsService,
	numbersService,
	trunksService,
	domainsService,
	welcomeDemoService,
]);

export default services;
