import { AuthzServer } from "./AuthzServer";
import { DummyAuthzHandler } from "./DummyAuthzHandler";

new AuthzServer().listen(new DummyAuthzHandler());
