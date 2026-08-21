# Building an End-to-End Type-Safe System

A blueprint for making one type definition flow from the database row, through the
HTTP boundary, into the client, and all the way down to which JSX branch renders.

This document is stack-agnostic in intent. The reference implementation uses
[Effect](https://effect.website) + `@effect/platform` `HttpApi`, but every section
names the property being bought and how to buy it with other tools (tRPC, ts-rest,
zod + OpenAPI, or a hand-rolled contract object). Read the **Principle** and the
**Portability** notes if you are not on Effect; read the code if you are.

---

## 0. What "end-to-end type-safe" actually has to mean

Most codebases that claim type safety only have *type-checked seams*: the server
compiles, the client compiles, and a hand-written `interface` in the middle keeps
them politely disagreeing. That is not end-to-end safety. It is two safe systems
joined by an unsafe cable.

A system is end-to-end type-safe when **all six** of these hold:

| # | Property | Failure mode it removes |
|---|---|---|
| 1 | There is exactly **one** declaration of each payload/response shape | Client and server drift |
| 2 | The declaration is **executable** — it validates at runtime, not just at compile time | `any` from `JSON.parse`, trusted-but-wrong input |
| 3 | **Failures are in the type**, enumerated and named | `catch (e) {}`, stringly-typed errors, unhandled 4xx |
| 4 | The client is **derived**, never authored | Codegen drift, stale SDK, forgotten regeneration |
| 5 | Values are **decoded at the boundary** into domain types, not passed as raw transport types | `status: string` where only four strings are legal |
| 6 | The **UI is forced to handle every state** the contract admits | Blank screens, spinners that never resolve, silent failures |

Properties 1–4 are what people usually mean. **Properties 5 and 6 are where the real
leverage is**, and they are the ones almost everyone skips. The rest of this document
is mostly about earning 5 and 6, because 1–4 come nearly free once you pick a decent
library.

---

## 1. The spine: one artifact, four consumers

The central move is to make the API **a value in your program**, not a set of
route-registration side effects.

```
                 ┌────────────────────┐
                 │   API definition   │   ← the only source of truth
                 │  (schemas + routes │
                 │   + errors + auth) │
                 └─────────┬──────────┘
                           │
        ┌──────────────┬───┴────┬──────────────┐
        ▼              ▼        ▼              ▼
   server router   typed     OpenAPI       test client
   (handlers must  client    document      (same client,
    satisfy it)   (derived)  (generated)    fake transport)
```

Because all four are *derived from the same value*, they cannot disagree. There is no
"regenerate the SDK" step to forget, because there is no SDK — there is a function
that takes the API value and returns a client.

### The definition

```ts
// ── schemas/Project.ts ─────────────────────────────────────────────
// A response shape. Note it is a class: it is a schema AND a constructor
// AND a runtime type you can `instanceof`.
export class Project extends Schema.Class<Project>("Project")({
  uid: Schema.String,
  name: Schema.String,
  status: Schema.Literal("draft", "active", "archived"),
  owner: Schema.NullOr(Schema.Struct({ uid: Schema.String, name: Schema.String })),
  created_at: Schema.DateTimeUtc,
}) {}

// ── schemas/ProjectNotFound.ts ─────────────────────────────────────
// An error shape. Tagged: it carries a discriminant so it can be matched.
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound",
  { message: Schema.String }
) {}

// ── ProjectsApi.ts ─────────────────────────────────────────────────
export class ProjectsApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("list", "/projects")
      .setUrlParams(Schema.Struct({ q: Schema.optional(Schema.String), ...PaginationQuery.fields }))
      .addSuccess(paginated(Project))
  )
  .add(
    HttpApiEndpoint.get("findById", "/projects/:uid")
      .setPath(Schema.Struct({ uid: Schema.String }))
      .addSuccess(Project)
      .addError(ProjectNotFound, { status: 404 })
  )
  .add(
    HttpApiEndpoint.post("create", "/projects")
      .setPayload(ProjectCreate)
      .addSuccess(Project)
      .addError(QuotaExceeded, { status: 402 })
  )
  .middleware(Authorization)          // auth is part of the contract, see §5
  .annotateContext(OpenApi.annotations({ title: "Projects" })) {}

// ── Api.ts ─────────────────────────────────────────────────────────
export class Api extends HttpApi.make("Api")
  .add(ProjectsApi)
  .add(MembersApi)
  .prefix("/api") {}
```

Read what is encoded there: method, path, path params, query params, body, success
shape, **the exhaustive set of failures with their status codes**, and the auth
scheme. That is the entire contract. Nothing about it lives in a handler.

### Consumer A — the server

Handlers *implement* the contract. The compiler rejects a handler that returns the
wrong shape, fails with an error the endpoint never declared, or forgets an endpoint
in the group.

```ts
export const projectsFindById = HttpApiBuilder.handler(Api, "projects", "findById", (args) =>
  Effect.gen(function* () {
    //   args.path.uid : string          ← decoded, not `string | undefined`
    const project = yield* repo.project.findFirst({ where: { uid: args.path.uid } });

    if (!project) {
      // Returning an undeclared error is a *type error*.
      return yield* new ProjectNotFound({ message: "Project not found" });
    }

    return serializeProject({ project });   // must return `Project`
  })
);

export const ProjectsApiLive = HttpApiBuilder.group(Api, "projects", (h) =>
  h.handle("list", projectsList)
   .handle("findById", projectsFindById)
   .handle("create", projectsCreate)      // omit one → compile error
);
```

### Consumer B — the client (derived, zero codegen)

```ts
const make = HttpApiClient.make(Api).pipe(Effect.provide(FetchHttpClient.layer));

export class ApiClient extends Context.Tag("ApiClient")<
  ApiClient,
  Effect.Effect.Success<typeof make>
>() {
  static readonly Live = Layer.effect(this, make);
}
```

`client.projects.findById({ path: { uid } })` is fully typed in both channels: success
is `Project`, failure is `ProjectNotFound | Unauthorized | HttpClientError |
ParseError`. **You did not write or generate a single line of client code.** Add an
endpoint to the API value and it appears on the client; change a payload and every
caller fails to compile.

### Consumer C — the OpenAPI document

```ts
const spec = OpenApi.fromApi(Api);
```

The document is a *projection* of the contract, so it cannot be stale. Commit it and
diff it in CI (§7) so contract changes become reviewable artifacts.

### Consumer D — tests

The same derived client, pointed at an in-process transport. That is the subject of
the companion guide, [`database-backed-test-ecosystem.md`](./database-backed-test-ecosystem.md).

> **Portability.** tRPC gives you A/B/D with inferred types but no HTTP contract or
> OpenAPI, and errors are not typed per-procedure. ts-rest gives you A/B/C/D over a
> zod contract but no typed error channel. A hand-rolled version is viable: define a
> `const contract = { list: { method, path, params: ZodSchema, response: ZodSchema,
> errors: { 404: ZodSchema } } }` object, then write a couple hundred lines to derive
> a fetch client and an Express router from it. The pattern matters far more than the
> library.

---

## 2. Schemas are codecs, not validators

This is the single most consequential design decision, and the one most often gotten
wrong.

A **validator** answers *is this value OK?* — it returns a boolean or throws, and the
value keeps whatever static type it already had. A **codec** answers *turn this
untrusted input into this domain type, or explain why not* — it has two type
parameters, an encoded (wire) type `I` and a decoded (domain) type `A`, and it works
in both directions.

```ts
Schema.DateTimeUtc        // wire: string     domain: DateTime.Utc
Schema.NumberFromString   // wire: "30"       domain: 30
parseJson(ConfigSchema)   // wire: string     domain: Config
```

Consequences you get for free once schemas are codecs:

**Query strings decode to real types.** `page` arrives as `"2"` and the handler
receives `2`. No `parseInt`, no `Number.isNaN` check, no `?? 1` fallback.

```ts
export const PaginationQuery = Schema.Struct({
  page:     Schema.optionalWith(Schema.NumberFromString.pipe(Schema.clamp(1, 1000)), { default: () => 1 }),
  per_page: Schema.optionalWith(Schema.NumberFromString.pipe(Schema.clamp(1, 100)),  { default: () => 30 }),
});
```

Clamping lives in the schema, so **no handler can be reached with `per_page: 100000`**.
The constraint is enforced structurally, once, instead of being re-checked in every
handler and forgotten in one of them.

**The same schema serialises the response.** Encoding is decoding backwards, so
`DateTime` → ISO string on the way out is the same declaration.

**The same schema drives client-side form validation.** One resolver adapter, and your
form validates against the exact schema the server will validate against:

```ts
export const effectTsResolver: Resolver = (schema, config) => (values, _, options) =>
  ParseResult.decodeUnknown(schema, config)(values).pipe(
    Effect.catchAll((issue) => Effect.flip(ArrayFormatter.formatIssue(issue))),
    Effect.mapError((issues) =>
      toNestErrors(
        issues.reduce(
          (acc, i) => ({ ...acc, [i.path.join(".")]: { message: i.message, type: i._tag } }),
          {} as FieldErrors
        ),
        options
      )
    ),
    Effect.match({
      onFailure: (errors) => ({ errors, values: {} }),
      onSuccess: (values) => ({ errors: {}, values }),
    }),
    Effect.runPromise
  );
```

Roughly thirty lines buys you *the client can never submit something the server will
reject for shape reasons*. The structured issue list (`path` + `message` + `_tag`) is
what makes this possible — a validator that throws a string cannot be mapped onto form
fields.

**Schemas compose into new codecs.** Need YAML in a text editor validated as a typed
object? Write the transform once and it plugs in anywhere a schema fits:

```ts
export const parseYaml = <A, I, R>(schema?: Schema.Schema<A, I, R>) =>
  Schema.isSchema(schema)
    ? Schema.compose(parseYaml(), schema)
    : Schema.transformOrFail(YamlString, Schema.Unknown, {
        strict: true,
        decode: (s, _, ast) =>
          ParseResult.try({ try: () => YAML.parse(s),     catch: (e: any) => new ParseResult.Type(ast, s, e.message) }),
        encode: (u, _, ast) =>
          ParseResult.try({ try: () => YAML.stringify(u), catch: (e: any) => new ParseResult.Type(ast, u, e.message) }),
      });
```

> **Portability.** zod is a codec system too — `z.coerce`, `.transform()`, `.pipe()` —
> though its `input`/`output` split is less rigorous and it cannot encode. If you use
> zod, still adopt the *discipline*: define transport→domain transforms in the schema,
> never in the handler. Valibot and TypeBox are comparable. In Rust or Kotlin, serde
> and kotlinx-serialization already work this way.

---

## 3. Errors are values with names

The error channel is where type safety usually dies. `throw` erases types, `catch`
gives you `unknown`, and HTTP gives you an integer.

### Rule 1 — every expected failure is a tagged type

```ts
export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound", { message: Schema.String }
) {}

export class QuotaExceeded extends Schema.TaggedError<QuotaExceeded>()(
  "QuotaExceeded", { message: Schema.String, limit: Schema.Number }
) {}
```

Three things at once: a **schema** (serialises across the wire and back), a
**constructor** (`new QuotaExceeded({ limit: 10 })`), and a **discriminant**
(`_tag: "QuotaExceeded"`) that makes exhaustive matching possible. The error survives
the network round-trip *as itself* — the client receives a `QuotaExceeded` instance
with `limit: 10`, not `{ error: "quota exceeded" }`.

### Rule 2 — expected failures are typed; unexpected failures are not

This distinction is what keeps the error union from metastasising.

- **Expected** (`ProjectNotFound`, `QuotaExceeded`, `Unauthorized`): a caller can
  reasonably do something about it. These belong in the signature and in the contract.
- **Unexpected** (`DbError`, connection resets, bugs): nobody up the stack can act on
  it; it should become a 500, an alert, and a stack trace.

Push unexpected failures out of the type at the boundary where they stop being
actionable:

```ts
Effect.gen(function* () {
  /* ... handler body ... */
}).pipe(Effect.catchTag("DbError", Effect.die))
//                                 ^^^^^^^^^^^ defect, not a typed failure
```

Now `DbError` cannot appear in the endpoint's declared errors, the client's error
union stays small and meaningful, and the database still fails loudly. Without this
move, `DbError` infects every signature in the codebase and the union becomes useless.

> The general principle: **the error type should list what the caller must decide
> about, not everything that can go wrong.** A signature with fourteen errors in it is
> telling you the boundary is in the wrong place.

### Rule 3 — status codes are an annotation, not the representation

```ts
.addError(ProjectNotFound, { status: 404 })
```

The status code is how the error is *transported*. `_tag` is what it *is*. Client code
branches on `_tag`; only the HTTP layer cares about 404. This is exactly why the same
contract can be served over HTTP, over an in-process handler in tests, or in principle
over a queue.

> **Portability.** Without a typed error channel — plain TypeScript, tRPC, ts-rest —
> get most of the way with a discriminated result type:
>
> ```ts
> type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
> type ProjectError =
>   | { _tag: "ProjectNotFound" }
>   | { _tag: "QuotaExceeded"; limit: number };
> ```
>
> You lose automatic propagation and short-circuiting, and you must remember to
> declare the error type on every procedure — but the exhaustive `switch (e._tag)` at
> the UI, which is where the value is, works identically.

---

## 4. The serializer seam

**Never return a database row from an endpoint.** Put an explicit, boring function
between them:

```ts
export const serializeProject = ({ project }: {
  project: DB.Project & { owner: DB.User | null };
}): Project =>
  new Project({
    uid: project.uid,
    name: project.name,
    status: project.status,                 // already a narrowed union — see the ORM guide
    owner: project.owner ? { uid: project.owner.uid, name: project.owner.name } : null,
    created_at: DateTime.unsafeMake(project.createdAt),
  });
```

It looks like ceremony. It is the highest-leverage fifteen lines in the codebase:

- **Adding a DB column cannot leak it.** Add `internalRiskScore` to the table and
  nothing appears in the API. Rows are auto-serialised in most frameworks, which is
  precisely how PII and internal flags escape.
- **Renaming a DB column cannot break the API.** The rename breaks *here*, in one
  file, at compile time. `snake_case` wire / `camelCase` domain stops being a problem
  you solve with a global transform.
- **The return type is checked against the contract.** Forget a required field and you
  get a compile error at the serializer, not a 500 at runtime.
- **The `include` requirement is in the signature.** `project: DB.Project & { owner:
  DB.User | null }` means a handler that forgot `include: { owner: true }` does not
  compile. The query and the response shape are coupled *statically*.
- **It is trivially unit-testable** — a pure function, no I/O.

One serializer per resource shape, colocated with its handlers. When two endpoints
return the same resource they call the same serializer, which is how consistency
becomes free rather than a review checklist item.

---

## 5. Authentication belongs in the contract

Auth is not middleware you bolt on. It is part of the type of an endpoint, and it
should be visible in the OpenAPI document.

```ts
export class Authorization extends HttpApiMiddleware.Tag<Authorization>()("Authorization", {
  failure:  Unauthorized,           // typed failure, added to every endpoint in the group
  provides: CurrentAuth,            // what handlers gain access to
  security: {                       // resolved in order; also emitted into OpenAPI
    userSession:      HttpApiSecurity.apiKey({ key: "__session", in: "cookie" }),
    apiToken:         HttpApiSecurity.bearer,
    componentSession: HttpApiSecurity.apiKey({ key: "__component", in: "cookie" }),
  },
});
```

Applying `.middleware(Authorization)` to a group does four things simultaneously:

1. Handlers in that group can `yield* CurrentAuth` — **and handlers in other groups
   cannot**, because it is not in their context. Unauthenticated access becomes a
   compile error rather than a code-review catch.
2. `Unauthorized` joins the declared error union, so the client must handle it.
3. The OpenAPI security scheme is emitted.
4. Tests exercise the real thing (see the test guide) — no `vi.mock("auth")`.

Model the *identity* as a tagged union, not a bag of optionals:

```ts
export const AuthSchema = Schema.Union(
  AuthApiToken,       // { token, account }
  AuthUserSession,    // { token, account, user }
  AuthComponentToken, // { token, account, createdAt }
  AuthAdminSession    // { token, user }              ← note: no account
);
```

`AuthAdminSession` genuinely has no account, so account access is `Option<Account>`,
and the handler must say what happens when it is absent:

```ts
const account = yield* auth.account.pipe(
  Effect.catchTags({ NoSuchElementException: () => unauthorizedMissingAccountContext })
);
```

Compare with `auth.account!` or `if (!auth.account) throw new Error("no account")`.
The union turns *admin sessions have no account* into a fact the compiler enforces at
every use site, forever.

Authorization (as opposed to authentication) rides the same channel:

```ts
yield* auth.can("manage", auth.subject("Project", project));

// or, to push the check into the query:
const where = yield* auth.accessibleBy("Project", { status: "active" });
```

`accessibleBy` returning a *filter* rather than a boolean is worth stealing: it makes
authorization compose with pagination and search instead of fighting them, and it
means list endpoints cannot leak rows they then filter out in JS.

---

## 6. Carrying the types into the UI

Everything above is table stakes. This section is the part most teams never build, and
it is where type safety turns into user-visible quality.

### 6.1 One runtime, at the edge

```ts
export const AppRuntime = ManagedRuntime.make(ApiClient.Live);
```

One place where effects meet the imperative world. Services (the API client, tracing,
config) are provided once rather than threaded through components.

### 6.2 Convert the error channel into data at the boundary

```ts
export function useProject(uid: string) {
  return useQuery({
    queryKey: ["project", uid],
    queryFn: () =>
      Effect.gen(function* () {
        const client = yield* ApiClient;
        return yield* client.projects.findById({ path: { uid } });
      }).pipe(Effect.either, AppRuntime.runPromise),
    //       ^^^^^^^^^^^^^ the crucial line
  });
}
```

`Effect.either` turns `Effect<Project, ProjectNotFound | Unauthorized>` into
`Effect<Either<ProjectNotFound | Unauthorized, Project>>` — **a failure becomes a value
in the success channel.**

Why this matters so much:

- Query libraries type `error` as `unknown` (or whatever you assert). Passing the
  domain error through `data` keeps it fully typed all the way into JSX.
- It splits the two axes cleanly. `isPending` / `isError` are *transport* states (in
  flight, network down, retrying). `Either.left` is a *domain* state (the server
  answered, and the answer is "not found"). Conflating them is why apps show
  "Something went wrong" for a 404.
- The component now receives a value it must destructure, and TypeScript makes it
  handle both sides.

### 6.3 Render every state, exhaustively

The state space of a screen is the product of transport state × domain result:

```tsx
export default function ProjectPage() {
  const { uid } = useParams();
  const query = useProject(uid!);

  // ── transport axis ────────────────────────────────
  if (query.isPending) return <Skeleton />;
  if (query.isError)   return <ConnectionError onRetry={query.refetch} />;

  // ── domain axis ───────────────────────────────────
  return Either.match(query.data, {
    onLeft: (error) =>
      Match.value(error).pipe(
        Match.tag("ProjectNotFound", () => <NotFound resource="project" />),
        Match.tag("Unauthorized",    () => <SignInPrompt returnTo={location.pathname} />),
        Match.tag("QuotaExceeded",   (e) => <UpgradePrompt limit={e.limit} />),
        Match.exhaustive,          // ← add an error to the API and this stops compiling
      ),
    onRight: (project) => <ProjectView project={project} />,
  });
}
```

`Match.exhaustive` is the payoff for everything in §3. The day someone adds
`.addError(ProjectArchived, { status: 410 })` to the endpoint, **every screen that
consumes it fails to compile** until a human decides what an archived project should
look like. The contract change propagates all the way to the pixels.

Note also that `QuotaExceeded` carried `limit: number` across the wire, so the upgrade
prompt can say *"You have used all 10 projects on the Free plan"* instead of *"Something
went wrong."* Typed errors are a UX feature, not a purity exercise.

`ts-pattern`'s `match(...).with({ _tag: "..." }, ...).exhaustive()` is equivalent if
you prefer it, and works on plain discriminated unions with no Effect involved.

### 6.4 Mutations: match in the callback, not at the call site

```ts
export function useProjectCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProjectCreateInput) =>
      Effect.gen(function* () {
        const client = yield* ApiClient;
        return yield* client.projects.create({ payload: input });
      }).pipe(Effect.either, AppRuntime.runPromise),

    onSuccess: (result) =>
      Either.match(result, {
        onLeft: (e) =>
          Match.value(e).pipe(
            Match.tag("QuotaExceeded", (e) => toast.error(`Limit of ${e.limit} reached`)),
            Match.orElse(() => toast.error("Could not create project")),
          ),
        onRight: (project) => {
          toast.success(`${project.name} created`);
          qc.invalidateQueries({ queryKey: ["projects"] });
        },
      }),
  });
}
```

`onSuccess` fires for both branches — it means *the request completed* — and the
`Either` carries the actual outcome. This keeps the transport-level retry and error
semantics of the query library from being overloaded with domain meaning.

### 6.5 Schema-driven UI dispatch

The strongest form of this pattern: when the shape of a thing is a tagged union in the
schema, the UI is a `match` over that union and the compiler tracks coverage.

```ts
// Each variant is a schema, discriminated by `type`.
export const TextField = Schema.Struct({
  path: pathSchema,
  type: Schema.Literal("text"),
  required: requiredOption,
  options: createOptions({
    placeholder: Schema.optional(Schema.NullOr(Schema.String)).annotations({
      description: "Placeholder text for empty input",
      examples: ["Your first name"],
    }),
    max: Schema.optional(Schema.NullOr(Schema.Number)).annotations({
      description: "The maximum number of characters the input should accept",
      examples: [25],
    }),
  }),
}).annotations({ identifier: "Text Field", description: "Text field" });

export const FormField = Schema.Union(
  TextField, NumberField, DateField, AddressField, SignatureField, /* ... */
).annotations({ identifier: "Form Field" });
```

```tsx
return match(field)
  .with({ type: "text" },      (f) => <TextInput      {...common(f)} max={f.options?.max} />)
  .with({ type: "number" },    (f) => <NumberInput    {...common(f)} />)
  .with({ type: "address" },   (f) => <AddressInput   {...common(f)} />)
  .with({ type: "signature" }, (f) => <SignatureInput {...common(f)} />)
  .exhaustive();
```

Inside each branch, `f` is narrowed to that variant, so `f.options.max` exists on the
text branch and does not exist on the signature branch. Adding a field type then
becomes a mechanical, compiler-guided task: add the schema to the union, and fix every
`.exhaustive()` the compiler points at — validator, renderer, editor, serializer.
Nothing is missed, because nothing *can* be missed.

The same union generates the runtime validator for the form and, via `annotations`,
its own documentation. Those `description` and `examples` annotations are not
comments — they land in the OpenAPI document and in generated docs.

---

## 7. Guarding the contract in CI

Two cheap checks convert "we have types" into "we cannot break consumers by accident":

**1. Snapshot the generated OpenAPI document and diff it.**

```ts
// pnpm api:spec         → write
// pnpm api:spec --check → verify (CI)
const apis = yield* Apis;
for (const { file, spec } of apis) {
  yield* check ? ApiSnapshot.check(file, spec) : ApiSnapshot.write(file, spec);
}
```

`check` re-encodes the spec, compares it to the committed file, prints a colourised
line-level diff, and fails. Contract changes now show up as reviewable diffs in the
PR, and an accidental breaking change is a red build instead of a customer incident.
It also gives reviewers a stable place to argue about API design.

**2. `tsc --noEmit` as a required check.**

Obvious, but load-bearing: every guarantee in this document is enforced by the type
checker. A build that does not run it has none of them.

---

## 8. Costs, honestly

This architecture is not free, and it is not right for everything.

- **Learning curve.** Effect in particular is a large surface. Expect a real ramp for
  new contributors; the generator/`yield*` style, `Layer`, and `Context.Tag` all need
  explaining. Budget for it, or pick a lighter library.
- **Type-check time.** Deeply inferred schemas and large unions cost compile seconds.
  Watch it (`tsc --diagnostics`, `@typescript/analyze-trace`) and annotate return types
  on the worst offenders.
- **Error messages.** A mismatch deep inside a schema can produce a genuinely awful
  diagnostic. Naming intermediate schemas (`Schema.Class`, `identifier` annotations)
  helps a great deal.
- **It is viral.** Half-adopting is the worst outcome — you pay the ceremony without
  earning exhaustiveness. Pick a boundary (for example, "all new API groups") and hold
  it.

**Adopt incrementally, in this order.** Each step is independently valuable:

1. **Serializers first.** Even with no other change, an explicit row→response function
   per resource removes leaks and decouples the DB schema from the API. Cheapest,
   biggest immediate win.
2. **Codec schemas at the boundary.** Parse, clamp, and default in the schema; delete
   the defensive code from handlers.
3. **A single API-definition value** with a derived client. Delete the hand-written
   client.
4. **Typed errors plus exhaustive matching in the UI.** This is the step that changes
   what the product feels like.
5. **Contract snapshot in CI.**

---

## Checklist

- [ ] One declaration per shape; the client is derived, never written or generated
- [ ] Schemas are codecs — transport→domain conversion, defaults, and clamping live in the schema
- [ ] Every expected failure is a named, tagged type carrying useful data
- [ ] Unexpected failures are converted to defects at the boundary and stay out of signatures
- [ ] HTTP status is an annotation; `_tag` is the identity
- [ ] An explicit serializer sits between every row and every response
- [ ] Serializer parameter types encode required relation loads
- [ ] Auth is contract-level: typed failure, typed context, declared security scheme
- [ ] Identity is a tagged union; absent fields are `Option`, never `!`
- [ ] The client converts the error channel to data (`Effect.either`) at the hook boundary
- [ ] Components branch on transport state and domain state separately
- [ ] Domain errors are matched exhaustively; adding an error breaks the build
- [ ] Polymorphic domain objects are tagged unions dispatched with exhaustive matching
- [ ] Generated OpenAPI is committed and diffed in CI
- [ ] `tsc --noEmit` is a required check

---

## See also

- [`database-backed-test-ecosystem.md`](./database-backed-test-ecosystem.md) — testing the contract against a real database through the real handler
- [`extending-the-orm-layer.md`](./extending-the-orm-layer.md) — making the database layer produce domain types, so §4 has something honest to serialize
