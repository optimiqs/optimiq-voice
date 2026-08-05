import { createAclsTestCases } from "./aclsTestCases";
import { createAgentsTestCases } from "./agentsTestCases";
import { createApiKeysTestCases } from "./apiKeysTestCases";
import { createApplicationsTestCases } from "./applicationsTestCases";
import { createCallsTestCases } from "./callsTestCases";
import { createCredentialsTestCases } from "./credentialsTestCases";
import { createDomainsTestCases } from "./domainsTestCases";
import { createNumbersTestCases } from "./numbersTestCases";
import { createSecretsTestCases } from "./secretsTestCases";
import { createTrunksTestCases } from "./trunksTestCases";
import { createUsersTestCases } from "./usersTestCases";
import { createWorkspacesTestCases } from "./workspacesTestCases";

function createTestCases(expect) {
  return [
    createApplicationsTestCases(expect),
    createCallsTestCases(expect),
    createApiKeysTestCases(expect),
    createUsersTestCases(expect),
    createSecretsTestCases(expect),
    createAclsTestCases(expect),
    createAgentsTestCases(expect),
    createDomainsTestCases(expect),
    createCredentialsTestCases(expect),
    createNumbersTestCases(expect),
    createWorkspacesTestCases(expect),
    createTrunksTestCases(expect)
  ];
}

export { createTestCases };
