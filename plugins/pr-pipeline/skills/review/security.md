# Security lane

The review's second agent. It looks only at the security surface of the diff and at what that surface reaches: this repo, the sibling systems, the third parties. It runs for every class, standalone too, in its own fresh agent, in parallel with the main reviewer, and its findings join the one posted review. Seven steps, in order.

## 1. Depth

Read the changed file list (`git diff --name-only $BASE...HEAD`) and the added lines, and pick one depth. The signals below are judged by reading, not matched by a regex; the hints are examples across stacks, not a complete list. The threat model's `Surface` section (when the profile names one) adds path globs that count as signals at the depth it gives them.

| Depth | When | Runs |
| --- | --- | --- |
| `skip` | every changed file is copy, style, docs, tests or static assets, and no signal fires | nothing is dispatched |
| `standard` | any signal fires | one security agent at the review's routed model and effort, never below sonnet · medium |
| `deep` | the class is `sensitive`, or a signal marked deep fires | opus · high; rings 2 and 3 of the impact check are mandatory |

| Signal | Path hints | Added-line hints | Depth |
| --- | --- | --- | --- |
| Entry points: routes, controllers, handlers, resolvers, API schemas, queue jobs and consumers, CLI commands, webhook receivers | `routes/`, `controllers/`, `handlers/`, `api/`, `resolvers/`, `*.graphql`, `openapi.*`, `jobs/`, `consumers/`, `workers/`, `commands/`, `cmd/`, `webhooks/` | `router.get(`, `@app.route`, `@GetMapping`, `http.HandleFunc`, `Route::post`, `@Mutation`, `subscribe(` | standard; deep when a new entry point is public or unauthenticated |
| Guards: authentication, sessions, tokens, middleware, policies, permission checks, tenant or owner scoping, and any bypass of them | `auth/`, `middleware/`, `policies/`, `guards/`, `permissions/`, `session*` | `authorize`, `can(`, `@PreAuthorize`, `login_required`, `[AllowAnonymous]`, `skip_before_action`, `withoutMiddleware`, `tenant_id`, `owner_id` | deep |
| Data access: raw SQL or query strings, ORM scope bypass, migrations and schema | `migrations/`, `schema.*`, `*.sql`, `repositories/`, `models/` | `raw(`, `execute(f"`, `` query(` ``, `$queryRawUnsafe`, `.objects.raw(`, `unscoped`, `withoutGlobalScope` | standard; deep for a scope bypass |
| Output shapes: serializers, resources, DTOs, GraphQL types, props sent to the client, log and telemetry calls | `serializers/`, `resources/`, `dto/`, `presenters/`, `types/` beside a schema | `toJSON`, `to_representation`, `res.json(`, page or view props, `logger.`, `console.log`, `captureException`, `setAttribute(` | standard |
| Input handling: validation, mass assignment, uploads, file paths, deserialization, redirects, raw HTML rendering | `requests/`, `validators/`, `forms/`, `uploads/` | `request.all()`, `**request.data`, `Object.assign(model, req.body)`, `pickle.loads`, `yaml.load(`, `unserialize(`, `redirect(`, `dangerouslySetInnerHTML`, `v-html`, `\|safe`, `innerHTML` | standard |
| Egress: HTTP clients, SDK calls, mail, outbound webhooks, LLM prompts and retrieval | `clients/`, `integrations/`, `mail/`, `notifications/`, `prompts/` | `fetch(`, `axios.`, `requests.post(`, `http.Post(`, `HttpClient`, `send_mail(`, `messages.create(`, `embeddings`, `retrieve(` | standard |
| Secrets, crypto and config: env and config files, keys, CORS, cookies, headers, CI workflows, container and infra files, dependency manifests and lockfiles | `.env*`, `config/`, `settings.*`, `.github/workflows/`, `Dockerfile`, `docker-compose*`, `*.tf`, `k8s/`, `helm/`, `package.json`, `go.mod`, `requirements*.txt`, `Gemfile`, `Cargo.toml`, lockfiles | `cors`, `SameSite`, `httpOnly`, `Set-Cookie`, `Content-Security-Policy`, `encrypt`, `md5`, `sha1`, `jwt`, `verify=False` | deep |
| Cross-system: a file the threat model or a `contracts: true` sibling marks as a boundary | shared schemas, event definitions, generated API clients, the paths the threat model's `Connected systems` names | a field, claim, enum value or column a sibling reads | deep |
| A secret-shaped string on an added line | any | the command below | standard; each hit goes to the agent as a hint |

```bash
git diff -U0 $BASE...HEAD | rg -i "^\+.*((api[_-]?key|secret|token|passw(or)?d)\w*[\"']?\s*(:|=|=>)\s*[\"'][^\"' ]{8,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})"
```

**Delta mode** (`since <sha>`): the lane runs again only when the delta itself fires a signal, at the depth the delta's signals give (`sensitive` still forces deep). Otherwise nothing is dispatched and the body line reads `Security: unchanged since <short sha>`.

## 2. The prompt file

Write `<criteriaDir>/security-prompt.md`:

1. The body of `agents/security.md` (two directories up from this skill's directory), verbatim: everything after its front matter. The plugin's own agent already carries it, so for that agent the prompt is sections 2 onward; CLI backends and a `securityAgent` override get the whole file.
2. Branch, base SHA, PR title and body.
3. The changed file list.
4. The depth and the signals that fired, with every secret-pattern hit as `path · line text`.
5. The threat model: the profile's `threatModel` as an absolute path, or `none: use the defaults`.
6. The repo rule files, as in the review prompt.
7. The siblings, one per line as `name · absolute path · contracts yes/no`, or `none`.
8. On a later round: the security findings already posted, one line each as `path:line · title · open|resolved`.
9. CLI backends only: the diff, cut as the review prompt's is.

## 3. Dispatch

In the same message as the main reviewer, so the two run in parallel:

| Backend | How it runs | Model and effort |
| --- | --- | --- |
| claude | Agent tool, `subagent_type: "pr-pipeline:security"`, prompt = sections 2 onward. With the profile's `securityAgent` set, that agent instead, with the whole file | `standard`: the review's routed model and effort, raised to sonnet · medium when lower. `deep`: opus · high |
| codex, opencode, custom | the review's command from the backend table, reading `security-prompt.md` in place of `review-prompt.md`, its output kept as `<criteriaDir>/security-<backend>.txt` | `review_model`; at `deep`, the backend's highest effort it maps to |

Parsing, the one re-ask, the `git status` check for opencode and custom, and the fallback to claude work as for the review; a fallback runs `pr-pipeline:security` at the depth's model and effort and records `flag: "Security lane fell back to claude/<model>: <reason>"`. A `securityAgent` whose reply still does not parse falls back the same way.

## 4. Merge

Merge the security findings into the main review's by `path:line`: on a collision keep one finding with the higher severity and confidence, carrying the security finding's `area`, `ring` and `attack`. A security finding without a complete `attack` (`actor`, `entry` and `gain` all filled) is dropped with `flag: "Security finding without an attack dropped: <path:line>"`. A high security finding that is not pre-existing sets the verdict to `changes_requested`.

## 5. Verify

Security findings always go to the separate verifier described under Verify in `SKILL.md`, for every class, with their `attack` in the findings JSON. The votes, drops and held confidences work as they do there.

## 6. The record file

Write `<criteriaDir>/security.json` after verification:

```json
{
  "depth": "standard",
  "headSha": "3f9c2ab",
  "signals": ["entry point: POST /orders/{id}/refund", "egress: payment SDK call"],
  "coverage": [{ "area": "authz", "status": "checked", "evidence": "..." }],
  "findings": [
    {
      "path": "src/orders/refund.ts", "line": 18, "severity": "high", "area": "authz", "ring": "diff",
      "title": "Any user can refund another tenant's order",
      "attack": { "actor": "a user of another tenant", "entry": "POST /orders/{id}/refund", "gain": "refunds an order they do not own" },
      "state": "posted" | "held" | "dropped"
    }
  ],
  "notVerified": ["first_party: billing-api is not checked out"]
}
```

`coverage` is the agent's rows after verification: an area whose only findings the verifier dropped goes back to `checked`. `notVerified` has one entry per `not_verified` row, `<area>: <why>`. At depth `skip`, write `depth`, `headSha` and empty lists. Stage 5 reads `attack` to write the fix's test, and stage 6c to drive the refused request.

## 7. Body line and record

The review body carries one `Security:` line, always, right after the conclusion paragraph and before the findings table:

| Case | Line |
| --- | --- |
| No security finding posted | `Security: clean · 9 areas checked, 3 n/a` (checked counts the `checked` rows and the `finding` rows whose findings were all held) |
| Security findings posted | `Security: 1 high · authz`: the count by severity of the posted security findings, then their areas (`Security: 1 high, 2 medium · authz, output`) |
| Depth `skip` | `Security: n/a · no security surface in the diff` |
| Delta with no signal | `Security: unchanged since abc1234` |

Any `not_verified` row adds ` · not verified: <area> (<why>)` to the end, one per area: `Security: clean · 9 areas checked, 2 n/a · not verified: first_party (billing-api is not checked out)`.

Record on stage `review`, in the existing calls: a `note` `Security: <depth> · <the body line's text after "Security: ">` (`Security: deep · 1 high · authz`), and a `flag` per `not_verified` area (`Security not verified: first_party (billing-api is not checked out)`).
