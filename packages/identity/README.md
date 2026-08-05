[![Discord](https://img.shields.io/discord/1016419835455996076?color=5865F2&label=Discord&logo=discord&logoColor=white)](https://discord.gg/4QWgSz4hTC) ![GitHub](https://img.shields.io/github/license/optimiqs/optimiq-voice?color=%2347b96d) ![Twitter Follow](https://img.shields.io/twitter/follow/optimiq-voice?style=social)

This document is a high-level overview of the Identity module, helpful for maintainers, contributors, and developers who want to understand its architecture and design or contribute to it.

This module is part of the [Optimiq Voice](https://optimiq.health) project. It does not do much by itself. It is intended to be combined with other modules to create a complete solution. For more information about the project, please visit [https://github.com/optimiqs/optimiq-voice](https://github.com/optimiqs/optimiq-voice).

<div align="center">
  <p align="center">
    <img src="https://raw.githubusercontent.com/optimiqs/optimiq-voice/0.6/assets/identity.png" />
  </p>
</div>

## About Identity

The Optimiq Voice Identity Module provides the cornerstone for secure user management, authentication, and authorization within the Optimiq Voice Ecosystem. It is designed with flexibility and scalability to accommodate the diverse and evolving needs of the various Optimiq Voice projects.

## Key Features

This module offers comprehensive identity management functionality, including creating, reading, updating, and deleting user and workspace entities. Users may represent individual accounts or service accounts. Workspaces organize users and streamline permission administration; a user can belong to multiple workspaces.

- **Authentication** via JSON Web Tokens (JWTs) — username/password, Multi-Factor Authentication (MFA), OAuth2, and token exchange.
- **Authorization** via Role-Based Access Control (RBAC) with predefined and custom roles.
- **Resource ownership** keyed by `accessKeyId` (`US…` for users, `WO…` for workspaces).

## Specification

The normative specification for this module — entities and resource ownership, the RBAC model, the
id/access/refresh token model, token exchanges, RS256 verification via `GetPublicKey`, and security
practices — lives in OpenSpec and is the source of truth:

➡️ [`openspec/specs/identity/spec.md`](../../openspec/specs/identity/spec.md)

Proposed changes to this capability live under [`openspec/changes/`](../../openspec/changes).
