# Plugin Registry Publish Endpoint Spec

> Research document for `lingfang-plugin publish` (`publish.ts`).
> Source: collab-api backend code analysis on `betav2` (2026-07-14).

---

## Endpoint Route

**`POST /api/plugin-registry/releases`**

| Component     | Value                                | Source                                      |
| ------------- | ------------------------------------ | ------------------------------------------- |
| Global prefix | `api`                                | `main.ts:76` — `app.setGlobalPrefix('api')` |
| Controller    | `@Controller()` (no prefix)          | `plugin-registry.controller.ts:21`          |
| Method        | `@Post('plugin-registry/releases')`  | `plugin-registry.controller.ts:26`          |
| Full path     | `POST /api/plugin-registry/releases` |                                             |

---

## Auth Requirements

### Guards (applied globally)

| Guard              | Behavior                                              | Source             |
| ------------------ | ----------------------------------------------------- | ------------------ |
| `ThrottlerGuard`   | 60 req/min/IP                                         | `app.module.ts:95` |
| `JwtAuthGuard`     | Requires valid JWT in `Authorization: Bearer <token>` | `app.module.ts:96` |
| `PermissionsGuard` | RBAC via `@RequirePermission` decorator               | `app.module.ts:99` |

### Permission check on this route

`@RequirePermission('team.plugin.upload', 'team.plugin.edit_draft')` — `plugin-registry.controller.ts:25`

**OR semantic**: user needs **either** `team.plugin.upload` (upload new plugin) **or** `team.plugin.edit_draft` (update existing package). Both are team-level permissions resolved from the user's current team membership role.

| Permission               | Label        | Description                               | Source                    |
| ------------------------ | ------------ | ----------------------------------------- | ------------------------- |
| `team.plugin.upload`     | 上传插件     | Upload new plugin for team                | `permission-codes.ts:151` |
| `team.plugin.edit_draft` | 编辑插件草稿 | Re-upload / edit draft of existing plugin | `permission-codes.ts:153` |

### Service-level enforcement

Inside `publishTeamRelease()`:

- If `packageId` is provided and package exists **and belongs to user's team**: call `ensurePackageActor()` with `'team.plugin.edit_draft'` check (lines 240-242).
- If `packageId` is not provided but package already exists for team+manifestId: same check (line 249).
- If creating **new** package (no `packageId`, no existing match): **TEAM_ADMIN** bypasses; otherwise requires `'team.plugin.upload'` permission (line 253).
- All require `auth.ensureCurrentTeam(userId)` which validates the user has an ACTIVE membership in their current team (service line 220).

---

## Request Schema

### CRITICAL: Raw binary stream, NOT multipart form upload

This endpoint **does NOT use** `@FileInterceptor`, `@UploadedFile`, `@Body`, or Multer. The `.lfplugin` file is sent as the **raw HTTP body** (binary stream). The controller method accepts `@Req() req: Request` and passes the Express `req` (which is a `Readable` stream) directly to `spoolUpload(stream)`.

**`plugin-registry.controller.ts:28-43`**:

```typescript
publish(
  @Req() req: Request,
  @Headers('x-plugin-package-id') packageId?: string,
  @Headers('content-length') contentLength?: string,
  @Headers('x-plugin-source-kind') sourceKind?: string,
  @Headers('x-plugin-source-label-b64') sourceLabelBase64?: string,
  @Headers('x-client') client?: string,
) {
  return this.registry.publishTeamRelease(
    requireUser(req).id,
    req,                          // <-- entire req is passed as Readable stream
    packageId,
    contentLength ? Number(contentLength) : undefined,
    { sourceKind, sourceLabelBase64, ingestChannel: client?.trim().toLowerCase() === 'desktop' ? 'DESKTOP' : 'API' },
  );
}
```

**`plugin-registry.service.ts:183-211`** — `spoolUpload()` reads the Request as a stream:

```typescript
for await (const raw of stream) {
  const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
  sizeBytes += chunk.length;
  if (sizeBytes > PLUGIN_ARTIFACT_MAX_BYTES) throw badRequest('插件制品大小超限');
  hash.update(chunk);
  if (!output.write(chunk)) await once(output, 'drain');
}
```

### HTTP Headers (metadata)

| Header                      | Required | Type                                     | Description                                                                                                                        | Source                                 |
| --------------------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Authorization`             | **Yes**  | `Bearer <JWT>`                           | JWT auth token                                                                                                                     | Global guard                           |
| `Content-Type`              | No       | `application/octet-stream` (recommended) | Raw `.lfplugin` binary — no multipart                                                                                              | Readable stream                        |
| `Content-Length`            | No       | number                                   | Optional pre-check against 300MB limit                                                                                             | `controller.ts:31`                     |
| `x-plugin-package-id`       | No       | string (ULID)                            | Existing package ID to publish into. Omit to auto-create or reuse by manifestId+teamId match                                       | `controller.ts:30`                     |
| `x-plugin-source-kind`      | No       | enum string                              | `LINGFANG_CREATOR` / `EXTERNAL_TOOL` / `LOCAL_ARTIFACT` / `COPIED_INSTALLATION` / `API` / `LEGACY_MIGRATION` / `UNKNOWN` (default) | `controller.ts:32`, `model.ts:5-13`    |
| `x-plugin-source-label-b64` | No       | base64url-encoded UTF-8 string           | Human-readable origin label (max 80 chars decoded, max 512 bytes encoded)                                                          | `controller.ts:33`, `model.ts:38-55`   |
| `x-client`                  | No       | string                                   | If exactly `"desktop"`, ingest channel becomes `DESKTOP`; otherwise `API`                                                          | `controller.ts:34`, `controller.ts:41` |

### Body

**Raw `.lfplugin` ZIP file** as the HTTP request body. The backend reads it as a binary `Readable` stream, validates:

- Size ≤ 300 MB (`PLUGIN_ARTIFACT_MAX_BYTES`, `plugin-artifact.ts:14`)
- Not empty
- Valid `.lfplugin` v4 ZIP format (inspected via `inspectPluginArtifact`)
- Manifest version must be strict SemVer
- AI policy files pass validation

---

## Response Schema (Success)

**Status: `201 Created`** (NestJS defaults to 201 for POST)

Response body (`plugin-registry.service.ts:318`):

```typescript
return {
  package: packageJson(published.package),
  release: releaseJson(published.release),
};
```

### `package` shape

| Field              | Type                       | Description                                      |
| ------------------ | -------------------------- | ------------------------------------------------ |
| `id`               | string                     | ULID                                             |
| `ownerTeamId`      | string                     | Team ULID                                        |
| `authorUserId`     | string \| null             | User ULID                                        |
| `manifestId`       | string                     | Plugin manifest.id (e.g. `"team.external-demo"`) |
| `name`             | string                     | Display name                                     |
| `description`      | string                     | Description                                      |
| `governanceStatus` | `"ACTIVE"` \| `"ARCHIVED"` | Always `"ACTIVE"` for new                        |
| `createdAt`        | string (ISO 8601)          |                                                  |
| `updatedAt`        | string (ISO 8601)          |                                                  |

Source: `plugin-registry-model.ts:105-127`

### `release` shape

| Field                | Type                                    | Description                      |
| -------------------- | --------------------------------------- | -------------------------------- |
| `id`                 | string                                  | ULID                             |
| `packageId`          | string                                  | Package ULID                     |
| `version`            | string                                  | Strict SemVer from manifest      |
| `manifest`           | object                                  | Full manifest JSON               |
| `sha256`             | string                                  | Hex SHA-256 of artifact          |
| `sizeBytes`          | number                                  | File size                        |
| `status`             | `"PUBLISHED"`                           | Always `"PUBLISHED"` on creation |
| `marketReviewStatus` | `"DRAFT"`                               | Always `"DRAFT"` initially       |
| `targetPlatform`     | string                                  | e.g. `"windows-x64"`             |
| `sourceKind`         | `"UNKNOWN"` \| ...                      | Source kind enum                 |
| `sourceLabel`        | string                                  | Decoded source label             |
| `ingestChannel`      | `"API"` \| `"DESKTOP"` \| `"MIGRATION"` |                                  |
| `aiPolicyVersion`    | number                                  | Current policy version           |
| `aiPolicyStatus`     | `"PASSED"` \| `"UNCHECKED"` \| ...      |                                  |
| `aiPolicyReason`     | string                                  |                                  |
| `createdAt`          | string (ISO 8601)                       |                                  |

Source: `plugin-registry-model.ts:65-103`

---

## Error Codes

| HTTP Status | Error Code (in body)        | Description                                   | Source      |
| ----------- | --------------------------- | --------------------------------------------- | ----------- |
| 400         | `bad_request`               | Plugin artifact too large (> 300MB)           | service:185 |
| 400         | `bad_request`               | Plugin artifact is empty                      | service:204 |
| 400         | `bad_request`               | Version must be strict SemVer                 | service:52  |
| 400         | `bad_request`               | Invalid source kind / source label            | model:34,40 |
| 403         | `forbidden`                 | Cannot publish to other team's package        | service:240 |
| 403         | `forbidden`                 | Permission denied                             | service:241 |
| 404         | `not_found`                 | Specified packageId not found                 | service:244 |
| 404         | `not_found`                 | Package does not exist                        | model:93    |
| 409         | `conflict`                  | Version already exists (cannot overwrite)     | service:269 |
| 409         | `conflict`                  | Package archived (cannot publish new version) | service:264 |
| 409         | `conflict`                  | Manifest.id mismatches target package         | service:242 |
| 409         | `plugin_ai_policy_required` | AI policy check not current                   | service:62  |

The service uses `import { AppError, badRequest, conflict, forbidden, insufficientBalance, notFound }` from `../common` (service:10). All errors include a Chinese `message` and optional `metadata` object.

---

## Validation Rules (Summary)

| Rule                            | Limit                                                  | Source                  |
| ------------------------------- | ------------------------------------------------------ | ----------------------- |
| Max artifact size               | 300 MB                                                 | `plugin-artifact.ts:14` |
| Max files in archive            | 1,500                                                  | `plugin-artifact.ts:15` |
| Max file size within archive    | 60 MB                                                  | `plugin-artifact.ts:16` |
| Max metadata (JSON) size        | 256 KB                                                 | `plugin-artifact.ts:17` |
| Manifest version                | Strict SemVer (MAJOR.MINOR.PATCH, optional prerelease) | service:52              |
| Manifest id max length          | 128 bytes                                              | `plugin-artifact.ts:19` |
| Manifest name max length        | 128 bytes                                              | `plugin-artifact.ts:20` |
| Manifest description max length | 4096 bytes                                             | `plugin-artifact.ts:21` |
| Source label max decoded length | 80 chars (UTF-8)                                       | model:53                |
| Source label max encoded length | 512 bytes (base64url)                                  | model:40                |
| Body parser (Express `json`)    | 300 MB                                                 | `main.ts:63`            |

---

## Prerequisite State

1. **User must have a JWT** with a valid current team membership (ACTIVE, non-SUSPENDED team).
2. **User's team must have the `team.plugin.upload` permission** (for new packages) **or `team.plugin.edit_draft`** (for existing packages).
3. If `x-plugin-package-id` is provided: the package must exist, belong to the user's team, and be `ACTIVE` (not `ARCHIVED`).
4. If `x-plugin-package-id` is omitted: the backend auto-resolves by `ownerTeamId + manifestId` or creates a new package.
5. The `.lfplugin` file must be a valid v4 plugin format (ZIP + manifest at specific path).

---

## Empirical Probe Result

**Not run.** The backend requires:

- A running collab-api instance with database
- A registered user with a team
- JWT token
- A valid `.lfplugin` v4 file

Starting the backend requires database setup (`pnpm -C apps/collab-api db:setup`), which would modify the local development database. The user can run this probe themselves with their local dev environment.

---

## Implementation Notes for publish.ts

### 1. DO NOT use multipart/form-data

The endpoint expects **raw binary** in the request body. Use `fetch()` with:

```typescript
// Read the .lfplugin file as Buffer
const fileBuffer = await fs.promises.readFile(artifactPath);

const response = await fetch('http://localhost:3000/api/plugin-registry/releases', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(fileBuffer.length),
    ...(packageId ? { 'x-plugin-package-id': packageId } : {}),
    ...(sourceKind ? { 'x-plugin-source-kind': sourceKind } : {}),
    ...(sourceLabelBase64 ? { 'x-plugin-source-label-b64': sourceLabelBase64 } : {}),
    ...(isDesktop ? { 'x-client': 'desktop' } : {}),
  },
  body: fileBuffer, // raw binary, NOT FormData
});
```

### 2. JWT auth token

Must be a valid JWT from `POST /api/auth/login`. The token is set on the user's current team memberships. The backend JwtAuthGuard extracts `req.user` from the token.

### 3. Content-Length optional but recommended

If provided, the backend validates it against 300MB before starting the stream. Omission is fine but the client won't get a fast 413 rejection.

### 4. Response on 201

```typescript
{
  "package": { "id": "pkg-ulid", "ownerTeamId": "...", ... },
  "release": { "id": "rel-ulid", "version": "1.0.0", "sha256": "...", "sizeBytes": 12345, ... }
}
```

### 5. Error handling

Read response body as JSON for error details:

```typescript
if (!response.ok) {
  const error = await response.json();
  // error.message = Chinese error description
  // error.metadata = additional context object
}
```

Response body shape for errors follows `AppExceptionFilter` conventions (likely `{ statusCode, message, error, metadata }`).

### 6. Summary of key differences from initial assumption

| Assumption                           | Reality                                 |
| ------------------------------------ | --------------------------------------- |
| Multipart form upload (`FormData`)   | Raw binary body stream                  |
| Field names (`file=`, `visibility=`) | All metadata via headers                |
| `@FileInterceptor` / `@UploadedFile` | `@Req() req: Request` streamed directly |
| Multer config                        | No Multer — custom `spoolUpload()`      |
| Content-Type `multipart/form-data`   | `application/octet-stream` or omitted   |
