import React from "react";
import type { SDK } from "../client/optimiq-voice.client";
import type {
  CookieSession,
  Session
} from "~/auth/services/sessions/session.interfaces";

/**
 * Props for the `OptimiqVoiceProvider` component.
 *
 * This provider is used to wrap your application in the Optimiq Voice context,
 * enabling global access to the Optimiq Voice client, SDK modules, and session management.
 */
export interface OptimiqVoiceProviderProps {
  /**
   * The child React elements (usually your entire app) that will be rendered
   * inside the context provider.
   */
  children: React.ReactNode;

  /**
   * The initial user session passed to the provider, typically obtained
   * at app start (e.g., from local storage or a server-rendered session).
   *
   * This session may include an access token, refresh token, and other
   * user-related authentication data.
   */
  initialSession: CookieSession | null;
}

/**
 * Represents the collection of SDK modules available from the Optimiq Voice platform.
 *
 * Each module provides a typed interface to interact with a specific domain
 * of Optimiq Voice's functionality (e.g., managing applications, users, trunks, etc.).
 */
export interface OptimiqVoiceModules {
  /**
   * Module for managing SIP applications.
   *
   * Provides operations to create, list, update, and delete applications,
   * which are used to route and control calls programmatically.
   */
  applications: SDK.Applications;

  /**
   * Module for managing SIP agents (users or devices).
   *
   * Agents represent endpoints that can register and make/receive calls.
   */
  agents: SDK.Agents;

  /**
   * Module for managing Access Control Lists (ACLs).
   *
   * Allows configuration of security policies and restrictions for call access.
   */
  acls: SDK.Acls;

  /**
   * Module for managing API keys.
   *
   * API keys are used to grant programmatic access to the Optimiq Voice platform
   * without using user credentials.
   */
  apiKeys: SDK.ApiKeys;

  /**
   * Module for managing call sessions.
   *
   * Allows interaction with ongoing or historical calls, such as retrieving call details.
   */
  calls: SDK.Calls;

  /**
   * Module for managing SIP credentials.
   *
   * Used to create and rotate passwords and credentials for SIP agents or devices.
   */
  credentials: SDK.Credentials;

  /**
   * Module for managing SIP domains.
   *
   * Domains define namespaces for organizing agents and routing calls.
   */
  domains: SDK.Domains;

  /**
   * Module for managing phone numbers.
   *
   * Provides tools to purchase, release, and configure phone numbers
   * for inbound and outbound calling.
   */
  numbers: SDK.Numbers;

  /**
   * Module for managing secrets and environment variables.
   *
   * Useful for securely storing API tokens, credentials, or other sensitive data
   * associated with applications or services.
   */
  secrets: SDK.Secrets;

  /**
   * Module for managing trunks (external SIP connections).
   *
   * Trunks connect Optimiq Voice to external carriers or SIP providers
   * to enable PSTN (public telephone network) access.
   */
  trunks: SDK.Trunks;

  /**
   * Module for managing user accounts.
   *
   * Enables operations like user creation, permission assignment, and listing users
   * in the platform's organization or workspace.
   */
  users: SDK.Users;

  /**
   * Module for managing workspaces.
   *
   * Workspaces are used to isolate configurations, resources, and permissions
   * for teams or projects within the same organization.
   */
  workspaces: SDK.Workspaces;
}

/**
 * The shape of the value provided by the `OptimiqVoiceContext`.
 *
 * This context is used throughout the application to access:
 * - The Optimiq Voice WebClient instance
 * - Current authentication state
 * - SDK modules for interacting with the backend
 * - Session update and logout utilities
 */
export interface OptimiqVoiceContextValue {
  /**
   * Instance of the Optimiq Voice WebClient used to make authenticated API calls.
   * This may be null if the client hasn't been initialized (e.g., user not logged in).
   */
  client: SDK.WebClient | null;

  /**
   * The current session object which may include tokens and user metadata.
   * This is used to determine if a user is authenticated and to authorize requests.
   */
  session: Session | null;

  /**
   * Function to set or update the session object.
   * Useful for handling login, logout, and token refresh workflows.
   *
   * @param session - A new session object or null to clear the session.
   */
  setSession: (session: Session | null) => void;

  /**
   * Function that logs the user out and clears session-related state.
   * Typically used to revoke access tokens and reset the client.
   */
  logout: () => void;

  /**
   * Boolean indicating whether the user is currently authenticated.
   * Usually based on whether a valid session or token is present.
   */
  isAuthenticated: boolean;

  /**
   * Object containing all initialized Optimiq Voice SDK modules.
   * Each module provides a typed interface to interact with its domain.
   * This will be null if the client has not been initialized.
   */
  sdk: OptimiqVoiceModules | null;

  /**
   * Function to authenticate the user based on a provided session.
   * This is typically called after a successful login or token refresh.
   *
   * @param session - The session object containing authentication tokens.
   */
  authenticate: (session: CookieSession) => Promise<void>;
}
