# @optimiq-voice/logging

Pino logging with mandatory redaction. This is a telephony platform, so phone numbers are PII
and SIP/ARI payloads routinely carry credentials — nothing reaches a transport unscrubbed.

## Exports

```ts
import { AppLogger, getLogger, getPinoLogger, setPinoLogger } from "@optimiq-voice/logging";
```

- `AppLogger` — `@Injectable()` NestJS `LoggerService`. Use it as the app logger and inject it
  into services. `withContext("CallsService")` derives a scoped logger.
- `getLogger(service)` — plain pino child logger for non-Nest processes (ARI/NATS workers,
  migration runners, CLI entry points). Binds `{ service }` to every line.
- `getPinoLogger()` / `setPinoLogger()` — the process-wide instance. Built lazily, so importing
  this package never opens a transport worker on its own.
- `scrubSensitiveString`, `redactLogValue`, `redactErrorValue`, `isSensitiveLogKey` — the
  redaction primitives, exported for anything that formats its own output.

## Redaction model

Two layers run together:

1. **Key names** — a field whose name looks sensitive is replaced wholesale with `[REDACTED]`:
   auth/cookie/token/secret/password/api-key/session/private-key/signature, plus telephony PII
   (`email`, `phone*`, `callerId`, `from_number`, `to_number`, `did`, `msisdn`, `dtmf`,
   `digits`, name and address fields).
2. **Values** — free-form strings are scrubbed for JWTs, `Bearer` tokens, `?token=`/`?api_key=`
   query credentials, `key: value` secret assignments, SIP and connection-URI userinfo,
   emails, E.164 numbers, and 64+ character hex tokens.

Traversal is depth-limited (`MAX_REDACTION_DEPTH` = 6, deeper values become `[Truncated]`) and
cycle-safe (`[Circular]`). `Date` values pass through; `Error` values become
`{ name, message, stack }` with all three scrubbed.

## Configuration

`LOG_LEVEL` sets the level (default `info` in production, `debug` elsewhere). `LOG_PRETTY=false`
forces JSON output outside production; production is always JSON to an async destination.

## Commands

```sh
pnpm --filter @optimiq-voice/logging build
pnpm --filter @optimiq-voice/logging typecheck
bun test packages/logging/src
```
