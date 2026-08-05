ctl
=================

Command-Line for Optimiq Voice

[![command-line tool](https://img.shields.io/badge/ctl-oclif-brightgreen.svg)](https://optimiq.health)
[![Version](https://img.shields.io/npm/v/@optimiq-voice/ctl.svg)](https://npmjs.org/package/@optimiq-voice/voice)
[![Downloads/week](https://img.shields.io/npm/dw/@optimiq-voice/ctl.svg)](https://npmjs.org/package/@optimiq-voice/voice)
[![License](https://img.shields.io/npm/l/@optimiq-voice/ctl.svg)](https://github.com/optimiqs/optimiq-voice/blob/main/package.json)

Use this tool to manage your Optimiq Voice resources from the command line. With this tool, you can create, update, and delete resources like Applications, Numbers, SIP Agents, and more.

> When connecting to your own instance of Optimiq Voice, remember to use your endpoint when login in. Also, remember to use the `--insecure` flag when connecting to a server with no TLS.

<!-- toc -->

- [Usage](#usage)
- [Commands](#commands)

<!-- tocstop -->

# Usage

<!-- usage -->

```sh-session
$ npm install -g @optimiq-voice/ctl
$ optimiq-voice COMMAND
running command...
$ optimiq-voice (--version)
@optimiq-voice/ctl/0.15.1 darwin-arm64 node-v22.14.0
$ optimiq-voice --help [COMMAND]
USAGE
  $ optimiq-voice COMMAND
...
```

<!-- usagestop -->

# Commands

<!-- commands -->

- [`optimiq-voice apikeys:create`](#optimiq-voice-apikeyscreate)
- [`optimiq-voice apikeys:delete REF`](#optimiq-voice-apikeysdelete-ref)
- [`optimiq-voice apikeys:list`](#optimiq-voice-apikeyslist)
- [`optimiq-voice apikeys:regenerate REF`](#optimiq-voice-apikeysregenerate-ref)
- [`optimiq-voice applications:create`](#optimiq-voice-applicationscreate)
- [`optimiq-voice applications:delete REF`](#optimiq-voice-applicationsdelete-ref)
- [`optimiq-voice applications:eval`](#optimiq-voice-applicationseval)
- [`optimiq-voice applications:get REF`](#optimiq-voice-applicationsget-ref)
- [`optimiq-voice applications:list`](#optimiq-voice-applicationslist)
- [`optimiq-voice applications:update REF`](#optimiq-voice-applicationsupdate-ref)
- [`optimiq-voice bug`](#optimiq-voice-bug)
- [`optimiq-voice feedback`](#optimiq-voice-feedback)
- [`optimiq-voice mcp:configure`](#optimiq-voice-mcpconfigure)
- [`optimiq-voice secrets:create`](#optimiq-voice-secretscreate)
- [`optimiq-voice secrets:delete REF`](#optimiq-voice-secretsdelete-ref)
- [`optimiq-voice secrets:get REF`](#optimiq-voice-secretsget-ref)
- [`optimiq-voice secrets:list`](#optimiq-voice-secretslist)
- [`optimiq-voice secrets:update REF`](#optimiq-voice-secretsupdate-ref)
- [`optimiq-voice sipnet:acls:create`](#optimiq-voice-sipnetaclscreate)
- [`optimiq-voice sipnet:acls:delete REF`](#optimiq-voice-sipnetaclsdelete-ref)
- [`optimiq-voice sipnet:acls:get REF`](#optimiq-voice-sipnetaclsget-ref)
- [`optimiq-voice sipnet:acls:list`](#optimiq-voice-sipnetaclslist)
- [`optimiq-voice sipnet:acls:update REF`](#optimiq-voice-sipnetaclsupdate-ref)
- [`optimiq-voice sipnet:agents:create`](#optimiq-voice-sipnetagentscreate)
- [`optimiq-voice sipnet:agents:delete REF`](#optimiq-voice-sipnetagentsdelete-ref)
- [`optimiq-voice sipnet:agents:get REF`](#optimiq-voice-sipnetagentsget-ref)
- [`optimiq-voice sipnet:agents:list`](#optimiq-voice-sipnetagentslist)
- [`optimiq-voice sipnet:agents:update REF`](#optimiq-voice-sipnetagentsupdate-ref)
- [`optimiq-voice sipnet:calls:create`](#optimiq-voice-sipnetcallscreate)
- [`optimiq-voice sipnet:calls:get REF`](#optimiq-voice-sipnetcallsget-ref)
- [`optimiq-voice sipnet:calls:list`](#optimiq-voice-sipnetcallslist)
- [`optimiq-voice sipnet:credentials:create`](#optimiq-voice-sipnetcredentialscreate)
- [`optimiq-voice sipnet:credentials:delete REF`](#optimiq-voice-sipnetcredentialsdelete-ref)
- [`optimiq-voice sipnet:credentials:get REF`](#optimiq-voice-sipnetcredentialsget-ref)
- [`optimiq-voice sipnet:credentials:list`](#optimiq-voice-sipnetcredentialslist)
- [`optimiq-voice sipnet:credentials:update REF`](#optimiq-voice-sipnetcredentialsupdate-ref)
- [`optimiq-voice sipnet:domains:create`](#optimiq-voice-sipnetdomainscreate)
- [`optimiq-voice sipnet:domains:delete REF`](#optimiq-voice-sipnetdomainsdelete-ref)
- [`optimiq-voice sipnet:domains:get REF`](#optimiq-voice-sipnetdomainsget-ref)
- [`optimiq-voice sipnet:domains:list`](#optimiq-voice-sipnetdomainslist)
- [`optimiq-voice sipnet:domains:update REF`](#optimiq-voice-sipnetdomainsupdate-ref)
- [`optimiq-voice sipnet:numbers:create`](#optimiq-voice-sipnetnumberscreate)
- [`optimiq-voice sipnet:numbers:delete REF`](#optimiq-voice-sipnetnumbersdelete-ref)
- [`optimiq-voice sipnet:numbers:get REF`](#optimiq-voice-sipnetnumbersget-ref)
- [`optimiq-voice sipnet:numbers:linkTwilioNumber`](#optimiq-voice-sipnetnumberslinktwilionumber)
- [`optimiq-voice sipnet:numbers:list`](#optimiq-voice-sipnetnumberslist)
- [`optimiq-voice sipnet:numbers:update REF`](#optimiq-voice-sipnetnumbersupdate-ref)
- [`optimiq-voice sipnet:trunks:create`](#optimiq-voice-sipnettrunkscreate)
- [`optimiq-voice sipnet:trunks:delete REF`](#optimiq-voice-sipnettrunksdelete-ref)
- [`optimiq-voice sipnet:trunks:get REF`](#optimiq-voice-sipnettrunksget-ref)
- [`optimiq-voice sipnet:trunks:list`](#optimiq-voice-sipnettrunkslist)
- [`optimiq-voice sipnet:trunks:update REF`](#optimiq-voice-sipnettrunksupdate-ref)
- [`optimiq-voice workspaces:active`](#optimiq-voice-workspacesactive)
- [`optimiq-voice workspaces:list`](#optimiq-voice-workspaceslist)
- [`optimiq-voice workspaces:login`](#optimiq-voice-workspaceslogin)
- [`optimiq-voice workspaces:logout REF`](#optimiq-voice-workspaceslogout-ref)
- [`optimiq-voice workspaces:use REF`](#optimiq-voice-workspacesuse-ref)

## `optimiq-voice apikeys:create`

create an API key for the active Workspace

```
USAGE
  $ optimiq-voice apikeys:create [-i] [-e <value>] [-r <value>]

FLAGS
  -e, --expiration=<value>  API Key expiration time in days(e.g. 10d) or months(e.g. 10m)
  -i, --insecure            allow connections to a server with no TLS
  -r, --role=<value>        [default: WORKSPACE_ADMIN] API Key role

DESCRIPTION
  create an API key for the active Workspace

EXAMPLES
  $ optimiq-voice apikeys:create
```

_See code: [dist/commands/apikeys/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/apikeys/create.js)_

## `optimiq-voice apikeys:delete REF`

delete an API key from the active Workspace

```
USAGE
  $ optimiq-voice apikeys:delete REF [-i]

ARGUMENTS
  REF  the ApiKey to delete from the Workspace

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete an API key from the active Workspace

EXAMPLES
  $ optimiq-voice apikeys:delete
```

_See code: [dist/commands/apikeys/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/apikeys/delete.js)_

## `optimiq-voice apikeys:list`

display all API keys in the active Workspace

```
USAGE
  $ optimiq-voice apikeys:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all API keys in the active Workspace

EXAMPLES
  $ optimiq-voice apikeys:list
```

_See code: [dist/commands/apikeys/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/apikeys/list.js)_

## `optimiq-voice apikeys:regenerate REF`

generate a new access key secret for an API key

```
USAGE
  $ optimiq-voice apikeys:regenerate REF [-i]

ARGUMENTS
  REF  the Application to update

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  generate a new access key secret for an API key

EXAMPLES
  $ optimiq-voice apikeys:regenerate
```

_See code: [dist/commands/apikeys/regenerate.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/apikeys/regenerate.js)_

## `optimiq-voice applications:create`

add a new Application to the active Workspace

```
USAGE
  $ optimiq-voice applications:create [-i] [-f <value>]

FLAGS
  -f, --from-file=<value>  create Application from YAML or JSON file
  -i, --insecure           allow connections to a server with no TLS

DESCRIPTION
  add a new Application to the active Workspace

EXAMPLES
  $ optimiq-voice applications:create
```

_See code: [dist/commands/applications/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/create.js)_

## `optimiq-voice applications:delete REF`

delete an Application from the active Workspace

```
USAGE
  $ optimiq-voice applications:delete REF [-i]

ARGUMENTS
  REF  the Application to delete

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete an Application from the active Workspace

EXAMPLES
  $ optimiq-voice applications:delete
```

_See code: [dist/commands/applications/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/delete.js)_

## `optimiq-voice applications:eval`

experimental command to test an Autopilot application

```
USAGE
  $ optimiq-voice applications:eval -f <value> [-i]

FLAGS
  -f, --file=<value>  (required) path to test cases file (json, yaml, or yml)
  -i, --insecure      allow connections to a server with no TLS

DESCRIPTION
  experimental command to test an Autopilot application

EXAMPLES
  $ optimiq-voice applications:eval -f assistant.json

  $ optimiq-voice applications:eval -f assistant.yaml
```

_See code: [dist/commands/applications/eval.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/eval.js)_

## `optimiq-voice applications:get REF`

retrieve details of an Application by reference

```
USAGE
  $ optimiq-voice applications:get REF [-i]

ARGUMENTS
  REF  The Application to show details about

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of an Application by reference

EXAMPLES
  $ optimiq-voice applications:get
```

_See code: [dist/commands/applications/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/get.js)_

## `optimiq-voice applications:list`

display all Applications in the active Workspace

```
USAGE
  $ optimiq-voice applications:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all Applications in the active Workspace

EXAMPLES
  $ optimiq-voice applications:list
```

_See code: [dist/commands/applications/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/list.js)_

## `optimiq-voice applications:update REF`

modify the configuration of an Application

```
USAGE
  $ optimiq-voice applications:update REF [-i] [-f <value>]

ARGUMENTS
  REF  the Application to update

FLAGS
  -f, --from-file=<value>  update Application from YAML or JSON file
  -i, --insecure           allow connections to a server with no TLS

DESCRIPTION
  modify the configuration of an Application

EXAMPLES
  $ optimiq-voice applications:update
```

_See code: [dist/commands/applications/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/applications/update.js)_

## `optimiq-voice bug`

report a bug to the development team 🐞

```
USAGE
  $ optimiq-voice bug

DESCRIPTION
  report a bug to the development team 🐞

EXAMPLES
  $ optimiq-voice bug
```

_See code: [dist/commands/bug.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/bug.js)_

## `optimiq-voice feedback`

provide feedback on your experience

```
USAGE
  $ optimiq-voice feedback

DESCRIPTION
  provide feedback on your experience
  ...
  Help us improve by providing some feedback


EXAMPLES
  $ optimiq-voice feedback
```

_See code: [dist/commands/feedback.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/feedback.js)_

## `optimiq-voice mcp:configure`

configure MCP client settings

```
USAGE
  $ optimiq-voice mcp:configure [-c claude] [-w <value>]

FLAGS
  -c, --client=<option>    [default: claude] MCP client to configure
                           <options: claude>
  -w, --workspace=<value>  workspace reference

DESCRIPTION
  configure MCP client settings

EXAMPLES
  $ optimiq-voice mcp:configure --client claude

  $ optimiq-voice mcp:configure --client claude --workspace my-workspace
```

_See code: [dist/commands/mcp/configure.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/mcp/configure.js)_

## `optimiq-voice secrets:create`

add a new Secret to the active Workspace

```
USAGE
  $ optimiq-voice secrets:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new Secret to the active Workspace

EXAMPLES
  $ optimiq-voice secrets:create
```

_See code: [dist/commands/secrets/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/secrets/create.js)_

## `optimiq-voice secrets:delete REF`

delete a Secret from the active Workspace

```
USAGE
  $ optimiq-voice secrets:delete REF [-i]

ARGUMENTS
  REF  the Secret reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete a Secret from the active Workspace

EXAMPLES
  $ optimiq-voice secrets:delete
```

_See code: [dist/commands/secrets/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/secrets/delete.js)_

## `optimiq-voice secrets:get REF`

retrieve details of a Secret by reference

```
USAGE
  $ optimiq-voice secrets:get REF [-i]

ARGUMENTS
  REF  The Secret to show details about

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a Secret by reference

EXAMPLES
  $ optimiq-voice secrets:get
```

_See code: [dist/commands/secrets/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/secrets/get.js)_

## `optimiq-voice secrets:list`

display all Secrets in the active Workspace

```
USAGE
  $ optimiq-voice secrets:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all Secrets in the active Workspace

EXAMPLES
  $ optimiq-voice secrets:list
```

_See code: [dist/commands/secrets/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/secrets/list.js)_

## `optimiq-voice secrets:update REF`

modify the value or metadata of a Secret

```
USAGE
  $ optimiq-voice secrets:update REF [-i]

ARGUMENTS
  REF  the Secret to update

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  modify the value or metadata of a Secret

EXAMPLES
  $ optimiq-voice secrets:update
```

_See code: [dist/commands/secrets/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/secrets/update.js)_

## `optimiq-voice sipnet:acls:create`

create a new Access Control List (ACL)

```
USAGE
  $ optimiq-voice sipnet:acls:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  create a new Access Control List (ACL)

EXAMPLES
  $ optimiq-voice sipnet:acls:create
```

_See code: [dist/commands/sipnet/acls/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/acls/create.js)_

## `optimiq-voice sipnet:acls:delete REF`

remove an Access Control List (ACL) from the Workspace

```
USAGE
  $ optimiq-voice sipnet:acls:delete REF [-i]

ARGUMENTS
  REF  the ACL reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  remove an Access Control List (ACL) from the Workspace

EXAMPLES
  $ optimiq-voice sipnet:acls:delete
```

_See code: [dist/commands/sipnet/acls/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/acls/delete.js)_

## `optimiq-voice sipnet:acls:get REF`

get a specific Access Control List (ACL)

```
USAGE
  $ optimiq-voice sipnet:acls:get REF [-i]

ARGUMENTS
  REF  The ACL reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  get a specific Access Control List (ACL)

EXAMPLES
  $ optimiq-voice sipnet:acls:get
```

_See code: [dist/commands/sipnet/acls/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/acls/get.js)_

## `optimiq-voice sipnet:acls:list`

list all Access Control Lists (ACLs)

```
USAGE
  $ optimiq-voice sipnet:acls:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  list all Access Control Lists (ACLs)

EXAMPLES
  $ optimiq-voice sipnet:acls:list
```

_See code: [dist/commands/sipnet/acls/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/acls/list.js)_

## `optimiq-voice sipnet:acls:update REF`

update an existing Access Control List (ACL)

```
USAGE
  $ optimiq-voice sipnet:acls:update REF [-i]

ARGUMENTS
  REF  the ACL reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  update an existing Access Control List (ACL)

EXAMPLES
  $ optimiq-voice sipnet:acls:update
```

_See code: [dist/commands/sipnet/acls/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/acls/update.js)_

## `optimiq-voice sipnet:agents:create`

add a new SIP Agent to the network

```
USAGE
  $ optimiq-voice sipnet:agents:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new SIP Agent to the network

EXAMPLES
  $ optimiq-voice sipnet:agents:create
```

_See code: [dist/commands/sipnet/agents/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/agents/create.js)_

## `optimiq-voice sipnet:agents:delete REF`

delete a SIP Agent from the network

```
USAGE
  $ optimiq-voice sipnet:agents:delete REF [-i]

ARGUMENTS
  REF  the Agent reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete a SIP Agent from the network

EXAMPLES
  $ optimiq-voice sipnet:agents:delete
```

_See code: [dist/commands/sipnet/agents/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/agents/delete.js)_

## `optimiq-voice sipnet:agents:get REF`

retrieve details of a SIP Agent

```
USAGE
  $ optimiq-voice sipnet:agents:get REF [-i]

ARGUMENTS
  REF  The Agent reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a SIP Agent

EXAMPLES
  $ optimiq-voice sipnet:agents:get
```

_See code: [dist/commands/sipnet/agents/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/agents/get.js)_

## `optimiq-voice sipnet:agents:list`

display all SIP Agents in the network

```
USAGE
  $ optimiq-voice sipnet:agents:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all SIP Agents in the network

EXAMPLES
  $ optimiq-voice sipnet:agents:list
```

_See code: [dist/commands/sipnet/agents/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/agents/list.js)_

## `optimiq-voice sipnet:agents:update REF`

add a new SIP Agent to the network

```
USAGE
  $ optimiq-voice sipnet:agents:update REF [-i]

ARGUMENTS
  REF  the ACL reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new SIP Agent to the network

EXAMPLES
  $ optimiq-voice sipnet:agents:update
```

_See code: [dist/commands/sipnet/agents/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/agents/update.js)_

## `optimiq-voice sipnet:calls:create`

initiate a call to a phone number or SIP URI

```
USAGE
  $ optimiq-voice sipnet:calls:create -f <value> -t <value> -a <value> [-i] [-o <value>] [-c] [-m <value>]

FLAGS
  -a, --app-ref=<value>   (required) the reference to the application to use
  -c, --track-call        track the call
  -f, --from=<value>      (required) the number to make the call from
  -i, --insecure          allow connections to a server with no TLS
  -m, --metadata=<value>  a JSON object with metadata for the voice application (e.g. '{"name": "John Doe"}')
  -o, --timeout=<value>   [default: 30] the call timeout
  -t, --to=<value>        (required) the number to make the call to

DESCRIPTION
  initiate a call to a phone number or SIP URI

EXAMPLES
  $ optimiq-voice sipnet:calls:create
```

_See code: [dist/commands/sipnet/calls/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/calls/create.js)_

## `optimiq-voice sipnet:calls:get REF`

get a specific Access Control List (ACL)

```
USAGE
  $ optimiq-voice sipnet:calls:get REF [-i]

ARGUMENTS
  REF  The ACL reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  get a specific Access Control List (ACL)

EXAMPLES
  $ optimiq-voice sipnet:calls:get
```

_See code: [dist/commands/sipnet/calls/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/calls/get.js)_

## `optimiq-voice sipnet:calls:list`

display all calls made in the active Workspace

```
USAGE
  $ optimiq-voice sipnet:calls:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all calls made in the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:calls:list
```

_See code: [dist/commands/sipnet/calls/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/calls/list.js)_

## `optimiq-voice sipnet:credentials:create`

add a new set of Credentials to the network

```
USAGE
  $ optimiq-voice sipnet:credentials:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new set of Credentials to the network

EXAMPLES
  $ optimiq-voice sipnet:credentials:create
```

_See code: [dist/commands/sipnet/credentials/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/credentials/create.js)_

## `optimiq-voice sipnet:credentials:delete REF`

delete a set of Credentials from the active Workspace

```
USAGE
  $ optimiq-voice sipnet:credentials:delete REF [-i]

ARGUMENTS
  REF  the Credentials reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete a set of Credentials from the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:credentials:delete
```

_See code: [dist/commands/sipnet/credentials/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/credentials/delete.js)_

## `optimiq-voice sipnet:credentials:get REF`

retrieve details of a set of Credentials by reference

```
USAGE
  $ optimiq-voice sipnet:credentials:get REF [-i]

ARGUMENTS
  REF  The Credentials reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a set of Credentials by reference

EXAMPLES
  $ optimiq-voice sipnet:credentials:get
```

_See code: [dist/commands/sipnet/credentials/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/credentials/get.js)_

## `optimiq-voice sipnet:credentials:list`

display all Credentials in the active Workspace

```
USAGE
  $ optimiq-voice sipnet:credentials:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all Credentials in the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:credentials:list
```

_See code: [dist/commands/sipnet/credentials/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/credentials/list.js)_

## `optimiq-voice sipnet:credentials:update REF`

modify the values or metadata of a set of Credentials

```
USAGE
  $ optimiq-voice sipnet:credentials:update REF [-i]

ARGUMENTS
  REF  the Credentials reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  modify the values or metadata of a set of Credentials

EXAMPLES
  $ optimiq-voice sipnet:credentials:update
```

_See code: [dist/commands/sipnet/credentials/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/credentials/update.js)_

## `optimiq-voice sipnet:domains:create`

add a new Domain to the SIP network

```
USAGE
  $ optimiq-voice sipnet:domains:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new Domain to the SIP network

EXAMPLES
  $ optimiq-voice sipnet:domains:create
```

_See code: [dist/commands/sipnet/domains/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/domains/create.js)_

## `optimiq-voice sipnet:domains:delete REF`

delete a Domain from the active Workspace

```
USAGE
  $ optimiq-voice sipnet:domains:delete REF [-i]

ARGUMENTS
  REF  the Domain reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete a Domain from the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:domains:delete
```

_See code: [dist/commands/sipnet/domains/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/domains/delete.js)_

## `optimiq-voice sipnet:domains:get REF`

retrieve details of a Domain by reference

```
USAGE
  $ optimiq-voice sipnet:domains:get REF [-i]

ARGUMENTS
  REF  The Domain reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a Domain by reference

EXAMPLES
  $ optimiq-voice sipnet:domains:get
```

_See code: [dist/commands/sipnet/domains/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/domains/get.js)_

## `optimiq-voice sipnet:domains:list`

display all Domains in the SIP network

```
USAGE
  $ optimiq-voice sipnet:domains:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all Domains in the SIP network

EXAMPLES
  $ optimiq-voice sipnet:domains:list
```

_See code: [dist/commands/sipnet/domains/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/domains/list.js)_

## `optimiq-voice sipnet:domains:update REF`

modify the configuration of a Domain

```
USAGE
  $ optimiq-voice sipnet:domains:update REF [-i]

ARGUMENTS
  REF  the Domain reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  modify the configuration of a Domain

EXAMPLES
  $ optimiq-voice sipnet:domains:update
```

_See code: [dist/commands/sipnet/domains/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/domains/update.js)_

## `optimiq-voice sipnet:numbers:create`

add a new Number to the SIP network

```
USAGE
  $ optimiq-voice sipnet:numbers:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new Number to the SIP network

EXAMPLES
  $ optimiq-voice sipnet:numbers:create
```

_See code: [dist/commands/sipnet/numbers/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/create.js)_

## `optimiq-voice sipnet:numbers:delete REF`

delete a Number from the active Workspace

```
USAGE
  $ optimiq-voice sipnet:numbers:delete REF [-i]

ARGUMENTS
  REF  the Numbers's reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  delete a Number from the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:numbers:delete
```

_See code: [dist/commands/sipnet/numbers/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/delete.js)_

## `optimiq-voice sipnet:numbers:get REF`

retrieve details of a Number by reference

```
USAGE
  $ optimiq-voice sipnet:numbers:get REF [-i]

ARGUMENTS
  REF  the Number to show details about

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a Number by reference

EXAMPLES
  $ optimiq-voice sipnet:numbers:get
```

_See code: [dist/commands/sipnet/numbers/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/get.js)_

## `optimiq-voice sipnet:numbers:linkTwilioNumber`

associate a Twilio number with a Optimiq Voice Application

```
USAGE
  $ optimiq-voice sipnet:numbers:linkTwilioNumber [-i] [-b <value>] [-a <value>]

FLAGS
  -a, --access-control-list=<value>  [default: 165.22.7.155/32] the access control list to allow (use if running your
                                     Optimiq Voice instance)
  -b, --outbound-uri-base=<value>    [default: pstn.optimiq.health] the uri to point twilio to for outbound calls (use if
                                     running your Optimiq Voice instance)
  -i, --insecure                     allow connections to a server with no TLS

DESCRIPTION
  associate a Twilio number with a Optimiq Voice Application

EXAMPLES
  $ optimiq-voice sipnet:numbers:linkTwilioNumber
```

_See code: [dist/commands/sipnet/numbers/linkTwilioNumber.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/linkTwilioNumber.js)_

## `optimiq-voice sipnet:numbers:list`

display all Numbers in the active Workspace

```
USAGE
  $ optimiq-voice sipnet:numbers:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to return

DESCRIPTION
  display all Numbers in the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:numbers:list
```

_See code: [dist/commands/sipnet/numbers/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/list.js)_

## `optimiq-voice sipnet:numbers:update REF`

modify the configuration of a Number

```
USAGE
  $ optimiq-voice sipnet:numbers:update REF [-i]

ARGUMENTS
  REF  the Number to update

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  modify the configuration of a Number

EXAMPLES
  $ optimiq-voice sipnet:numbers:update
```

_See code: [dist/commands/sipnet/numbers/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/numbers/update.js)_

## `optimiq-voice sipnet:trunks:create`

add a new Trunk to the SIP network

```
USAGE
  $ optimiq-voice sipnet:trunks:create [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  add a new Trunk to the SIP network

EXAMPLES
  $ optimiq-voice sipnet:trunks:create
```

_See code: [dist/commands/sipnet/trunks/create.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/trunks/create.js)_

## `optimiq-voice sipnet:trunks:delete REF`

remove a Trunk from the active Workspace

```
USAGE
  $ optimiq-voice sipnet:trunks:delete REF [-i]

ARGUMENTS
  REF  the Trunk's reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  remove a Trunk from the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:trunks:delete
```

_See code: [dist/commands/sipnet/trunks/delete.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/trunks/delete.js)_

## `optimiq-voice sipnet:trunks:get REF`

retrieve details of a Trunk by reference

```
USAGE
  $ optimiq-voice sipnet:trunks:get REF [-i]

ARGUMENTS
  REF  The Trunk's reference

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  retrieve details of a Trunk by reference

EXAMPLES
  $ optimiq-voice sipnet:trunks:get
```

_See code: [dist/commands/sipnet/trunks/get.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/trunks/get.js)_

## `optimiq-voice sipnet:trunks:list`

display all Trunks in the active Workspace

```
USAGE
  $ optimiq-voice sipnet:trunks:list [-i] [-s <value>]

FLAGS
  -i, --insecure           allow connections to a server with no TLS
  -s, --page-size=<value>  [default: 1000] the number of items to show

DESCRIPTION
  display all Trunks in the active Workspace

EXAMPLES
  $ optimiq-voice sipnet:trunks:list
```

_See code: [dist/commands/sipnet/trunks/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/trunks/list.js)_

## `optimiq-voice sipnet:trunks:update REF`

modify the configuration of a Trunk

```
USAGE
  $ optimiq-voice sipnet:trunks:update REF [-i]

ARGUMENTS
  REF  the Trunk to update

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  modify the configuration of a Trunk

EXAMPLES
  $ optimiq-voice sipnet:trunks:update
```

_See code: [dist/commands/sipnet/trunks/update.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/sipnet/trunks/update.js)_

## `optimiq-voice workspaces:active`

display the name of the active Workspace

```
USAGE
  $ optimiq-voice workspaces:active

DESCRIPTION
  display the name of the active Workspace

EXAMPLES
  $ optimiq-voice workspaces:active
```

_See code: [dist/commands/workspaces/active.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/workspaces/active.js)_

## `optimiq-voice workspaces:list`

display all linked Workspaces

```
USAGE
  $ optimiq-voice workspaces:list

DESCRIPTION
  display all linked Workspaces

EXAMPLES
  $ optimiq-voice workspaces:list
```

_See code: [dist/commands/workspaces/list.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/workspaces/list.js)_

## `optimiq-voice workspaces:login`

link a Workspace to the local environment

```
USAGE
  $ optimiq-voice workspaces:login [-i]

FLAGS
  -i, --insecure  allow connections to a server with no TLS

DESCRIPTION
  link a Workspace to the local environment

EXAMPLES
  $ optimiq-voice workspaces:login
```

_See code: [dist/commands/workspaces/login.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/workspaces/login.js)_

## `optimiq-voice workspaces:logout REF`

unlink a Workspace from the local environment

```
USAGE
  $ optimiq-voice workspaces:logout REF

ARGUMENTS
  REF  the Workspace to unlink from

DESCRIPTION
  unlink a Workspace from the local environment

EXAMPLES
  $ optimiq-voice workspaces:logout
```

_See code: [dist/commands/workspaces/logout.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/workspaces/logout.js)_

## `optimiq-voice workspaces:use REF`

set a Workspace as the default

```
USAGE
  $ optimiq-voice workspaces:use REF

ARGUMENTS
  REF  The Workspace to unlink from

DESCRIPTION
  set a Workspace as the default

EXAMPLES
  $ optimiq-voice workspaces:use
```

_See code: [dist/commands/workspaces/use.js](https://github.com/optimiqs/optimiq-voice/blob/v0.15.1/dist/commands/workspaces/use.js)_
<!-- commandsstop -->
