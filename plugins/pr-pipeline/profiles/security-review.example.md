# Security review: orders-service

Read by the pipeline's security lane before it reviews a PR, and by the implementer before it writes code. Save it as `SECURITY-REVIEW.md` at the repo root (or `.claude/security-review.md`, `docs/security-review.md`, or the path in the profile's `threatModel`). Keep each line a fact a reviewer can check against the code.

## Actors

Who can call the system and with what credential.

- Customer: browser session cookie; sees only their own account's orders.
- Support agent: SSO session with the `support` role; reads any account, refunds up to the limit in `config/refunds.*`.

## Entry points

Each surface (web, API, webhooks, jobs, CLI) with the guard it must carry.

- `/api/*`: bearer token, account scope from the token, never from the body.
- `POST /webhooks/payments`: provider signature checked in `src/webhooks/verify.*` before anything is read.

## Invariants

Numbered I1..In. Each: the rule · the area it belongs to (`authn`, `authz`, `injection`, `input`, `output`, `client`, `secrets`, `deps`, `blast_radius`, `first_party`, `third_party`, `llm`) · where it is enforced (path) · what a diff that breaks it looks like.

- I1. Every order query is scoped to the caller's account · `authz` · `src/orders/repository.*` · a query on orders that does not go through the repository, or a new method without the account filter.
- I2. Refund amounts are never taken from the client · `client` · `src/refunds/service.*` · a refund handler that reads `amount` from the request.

## Sensitive data

What it is, where it lives, where it must never go (client, logs, telemetry, third parties).

- Card fingerprint and billing address: `accounts.billing_*` columns; never in logs, error reports or analytics events.
- Internal notes on an order: support only; never in a customer-facing response.

## Connected systems

First-party: name, checkout (a profile sibling), what it consumes from us and we from it, the contract file. Third-party: name, client class, what data may leave, how inbound calls are verified.

- billing-api (sibling `billing-api`): consumes `order.paid` events, sends invoice ids back; contract in `contracts/events/order-paid.json`.
- Payment provider: client in `src/payments/client.*`; only order id, amount and currency leave; inbound webhooks verified by signature.

## Surface

Extra path globs that count as security surface here, with depth.

- `src/refunds/**`: deep.
- `src/exports/**`: standard.

## Not findings here

Accepted risks and patterns that look wrong but are intended.

- `GET /health` is public on purpose and returns no data.
- Support agents reading any account is intended; it is audited in `src/audit/*`.
