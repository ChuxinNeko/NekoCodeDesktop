# Antigravity model integration

Reference: the local `demo/CLIProxyAPI` checkout at commit
`b773607e3e7756dc6020a291825e4eb08899595a`. Runtime code is TypeScript under
`src/main`; no Go process or reference checkout is needed to run the app.

## Request contracts

| Behavior | Reference source | Desktop implementation |
| --- | --- | --- |
| OAuth, project discovery, onboarding | `internal/auth/antigravity/{constants,auth}.go` | `antigravity.ts`, `antigravity-oauth-service.ts` |
| Token safety window, refresh | `internal/runtime/executor/antigravity_executor_auth.go` | `antigravity-oauth-service.ts` |
| Daily endpoint, envelope, request/session IDs, headers | `internal/runtime/executor/antigravity_executor_request.go` | `antigravity-request.ts`, `antigravity-oauth-service.ts` |
| HTTP/1.1 without ALPN for generation | `internal/runtime/executor/antigravity_executor.go` | `antigravity-transport.ts` |
| Model IDs, limits, thinking capabilities | `internal/registry/models/models.json` | `antigravity-catalog.ts` |
| Thinking levels and Claude budgets | `internal/thinking/{convert.go,provider/antigravity/apply.go}` | `antigravity-request.ts` |
| Function schemas and tool names | `internal/util/{gemini_schema,translator,util}.go` | `antigravity-schema.ts`, `antigravity-request.ts` |
| Signature envelopes and replay policy | `internal/signature`, `internal/translator/antigravity/gemini` | `antigravity-signatures.ts`, `antigravity-request.ts` |
| Streaming and usage | `internal/runtime/executor/antigravity_executor_stream.go`, `helps/usage_helpers.go` | `antigravity-stream.ts` |

The catalog contains the 11 text-output models in that snapshot. Image-output
generation is not advertised. Text and supported image input, thinking output,
function calls, function results, streaming cancellation, and token accounting
are supported. Account entitlements and quota still determine upstream access.
Catalog registration and availability checks are local; a settings model test is
an explicit inference request.

PI retains raw response parts as additional assistant-message metadata. They
are replayed only for the same account/project and model, including after a
session is serialized. This replaces the reference proxy's protocol-translation
replay cache: there is no intermediate OpenAI/Anthropic conversion that discards
the original parts. Gemini bypass is used only for a missing/incompatible first
function-call signature, as in the reference sanitizer. Unsigned parallel sibling
calls stay unsigned. Claude thinking requires a compatible signature envelope.

VALIDATED schema placeholders (`reason` / `_`) are removed from local execution
arguments only when the adapter synthesized them. Real tool properties with
those names are preserved. Original provider arguments remain in replay metadata
so this local validation adjustment does not rewrite the signed history.

Each stream makes one upstream generation attempt. It does not switch endpoints,
rotate accounts, enable paid-credit retries, or fabricate a project. HTTP 429
records an account/model cooldown. Error messages show the upstream response
body (read limit: 64 KiB), with reflected credentials redacted. Logout aborts
requests holding the old account context.

## Validation and limits

Tests use simulated upstream responses, real loopback callback servers and a
loopback CONNECT server that inspects TLS ClientHello extensions. A PI runtime
integration test verifies model availability, custom streaming and logout.
Full PI Agent-loop tests cover both Gemini and Claude: parallel calls, tool
failures, invalid arguments, unknown tools, truncated calls, and strict empty
parameter schemas. Tools really execute in these tests; upstream responses are
simulated.
No live Google account is used by these tests.

This is a TypeScript implementation of the supported chat contracts, not an
execution of the Go proxy or a byte-identical port of every proxy feature.
Node/OpenSSL and Go/crypto-tls have different TLS fingerprints. Tool schema
normalization and native-part replay have focused regression coverage; full
differential coverage against every CLIProxyAPI translator fixture is not
claimed. The static catalog must be reviewed when the reference changes.
