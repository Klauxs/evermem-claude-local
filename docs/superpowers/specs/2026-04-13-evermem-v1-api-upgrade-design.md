# EverMem v1 API Upgrade — Design

**Date:** 2026-04-13
**Scope:** Hard-cut migration of the `evermem` Claude Code plugin from the deprecated v0 EverMind Cloud API to v1.

## Motivation

The v0 API is deprecated per https://docs.evermind.ai/api-reference/introduction and will be removed in a future release. The plugin currently relies on three v0 endpoints, one of which requires a `GET`-with-body curl hack. The v1 API fixes that ergonomic issue, renames response fields, changes add-memory semantics (batched messages, unix-ms timestamps, split personal/group/agent endpoints), and splits `get` into a `POST` body call.

## Decisions

- **Hard cut to v1.** No dual code paths, no feature flag. v0 call sites and the `GET`-with-body curl hacks are removed.
- **Keep groups.** The plugin continues to scope memory to a Claude Code session `group_id`. v1 `POST /api/v1/memories/group` accepts `group_id` inline — no pre-create needed via the Groups API. If `config.groupId` is absent, fall back to personal memories (`POST /api/v1/memories`).
- **Keep one-message-per-call add cadence.** The current hook fires once per user/assistant message. v1 accepts 1–500 messages per call, but batching is out of scope for this PR.
- **Dashboard must keep working.** It is migrated to v1 alongside the hooks.

## Endpoint mapping

| Op | v0 | v1 |
|---|---|---|
| Add (group) | `POST /api/v0/memories` (flat fields, one message) | `POST /api/v1/memories/group` with `{group_id, messages:[{sender_id, role, timestamp(ms int), content}], async_mode:true}` |
| Add (personal, fallback) | same | `POST /api/v1/memories` with `{user_id, messages:[...], async_mode:true}` |
| Search | `GET /api/v0/memories/search` with body (curl hack) | `POST /api/v1/memories/search` with `{query, filters:{user_id\|group_id}, method:'hybrid', memory_types:['episodic_memory'], top_k}` |
| Get / list | `GET /api/v0/memories?user_id&page&page_size&group_ids` | `POST /api/v1/memories/get` with `{memory_type:'episodic_memory', filters:{user_id\|group_id}, page, page_size, rank_by:'timestamp', rank_order:'desc'}` |

## Response shape changes

- v0 search/get: `result.memories[]`, content in `mem.episode`, title in `mem.subject`, score in `mem.score`, group in `mem.group_id`, participants in `mem.participants`, time in `mem.timestamp`.
- v1 **search**: `data.episodes[]` — content is `episode.summary` (⚠ renamed from `episode`), plus `subject`, `score`, `participants`, `timestamp` (ISO string), `group_id` may be absent on personal results.
- v1 **get**: `data.episodes[]` — content is `episode.episode` (coincidentally matches v0), plus `summary`, `subject` (if present), `timestamp` (ISO), `user_id`, `session_id`. Envelope also carries `total_count` and `count` (useful for pagination termination).

The transform helpers in both `hooks/scripts/utils/evermem-api.js` and `assets/dashboard.html` must read the correct content field per endpoint (search → `summary`, get → `episode`).

## File-by-file changes

### `hooks/scripts/utils/evermem-api.js`

1. **`searchMemories(query, options)`** — replace the curl hack with plain `fetch` `POST /api/v1/memories/search`.
   - Body: `{query, method: 'hybrid', top_k, memory_types: ['episodic_memory'], filters: config.groupId ? {group_id: config.groupId} : {user_id: config.userId}}`.
   - Drop `include_metadata`, `retrieve_method`, top-level `user_id`/`group_ids` (now inside `filters`).
   - Preserve the existing `_debug` envelope on the returned object so `evermem:debug` continues to work; replace `curl` with the equivalent request URL + sanitised body.

2. **`transformSearchResults(apiResponse)`** — read from `apiResponse.data.episodes` (not `apiResponse.result.memories`). Content field is `ep.summary`. Map `ep.subject`, `ep.score`, `ep.participants`, `ep.timestamp`, `ep.group_id`, `ep.memory_type` through to the existing plugin format. Keep the sort-by-score behavior.

3. **`addMemory(message)`** — switch to v1.
   - If `config.groupId`: `POST /api/v1/memories/group` with `{group_id, messages:[{sender_id, role, timestamp: Date.now(), content}], async_mode: true}`. `sender_id` = `config.userId` for user, `'claude-assistant'` for assistant.
   - Else: `POST /api/v1/memories` with `{user_id: config.userId, messages:[...], async_mode: true}`.
   - Remove `message_id`, `sender_name`, `create_time`, `group_name` (not in v1 schema). Keep the existing return envelope (`{url, body, status, ok, response}`) for the debug command.

4. **`getMemories(options)`** — switch to `POST /api/v1/memories/get`.
   - Body: `{memory_type: 'episodic_memory', filters: config.groupId ? {group_id: config.groupId} : {user_id: config.userId}, page, page_size, rank_by: 'timestamp', rank_order: 'desc'}`.
   - Use `fetch` POST with `Content-Type: application/json`.

5. **`transformGetMemoriesResults(apiResponse)`** — read from `apiResponse.data.episodes`. Content is `ep.episode`. Keep `subject`, `timestamp`, `groupId` mapping. Keep newest-first sort.

### `server/proxy.js`

6. Delete both `POST /api/v0/memories` and `POST /api/v0/memories/search` handlers (the curl-forwarder blocks at lines 107–173). The v0 endpoints are gone.
7. Add a single generic v1 forwarder: accept `POST /api/v1/memories/search` and `POST /api/v1/memories/get`, forward to `https://api.evermind.ai` with the same `Authorization` header and JSON body using `fetch` (no curl, no child_process). On non-2xx, pass the status and error body through to the client.
8. Remove the now-unused `execSync` import if it's not referenced elsewhere in `proxy.js`.
9. `/api/groups` and `/health` stay unchanged.

### `assets/dashboard.html`

10. **`fetchAllMemories()`** at line 754 — switch to v1.
    - First call `GET /api/groups` (already exists in the proxy). For each `group.id`, paginate `POST /api/v1/memories/get` with `filters: {group_id}`, `page_size: 100`, until `episodes.length < 100` or `page * 100 >= total_count`. Merge into a single list.
    - Fallback: if `/api/groups` returns an empty list, show an informative empty state instead of sending a placeholder `user_id: 'claude-code-user'` (which v1 would reject as unknown). Message: "No Claude Code sessions tracked yet. Run the plugin in a project first." (This changes observed behavior only in the edge case where the user has memories but no local `groups.jsonl` — acceptable given v1 requires a valid filter.)
11. **`transformApiResponse(apiResponse)`** at line 902 — read from `data.episodes[]` (not `result.memories`). Content: `ep.episode || ep.summary || ep.content || ''` (fallback chain so the same transform works whether the array was produced by `get` or `search`). Keep existing `subject`, `groupId`, `participants`, `timestamp`, `id` mappings.

### `README.md`

12. Replace all v0 endpoint references with v1 equivalents. Update the architecture diagram and the flow descriptions so `GET /api/v0/memories` becomes `POST /api/v1/memories/get`, `GET /api/v0/memories/search` becomes `POST /api/v1/memories/search`, and the "browser can't send GET with body" rationale for the proxy is replaced with "the proxy forwards browser calls to the EverMind API and serves the dashboard." Keep the `console.evermind.ai` links as-is.

### `scripts/test-retrieve-memories.js`, `scripts/test-save-memories.js`

13. Update the test scripts to hit v1 endpoints with v1 request/response shapes so `node scripts/test-*.js` remains a valid smoke test post-merge.

### `mcp/server.js`

14. Check for v0 references. If present, update to v1 following the same mapping. If not, no change.

## Error handling

- v1 errors return `{code, message, request_id, timestamp, path}` (not v0's shape). Any code that surfaces `error.message` or `errorData.message` continues to work since `message` exists in both. `errorData.error` references (used in the dashboard's catch block) fall back to the HTTP status text — acceptable.
- Preserve the current "return debug envelope on failure" behavior in `searchMemories` and `addMemory` so the `evermem:debug` command stays useful.

## Testing plan

1. **Smoke via scripts:** Run `node scripts/test-save-memories.js` then `node scripts/test-retrieve-memories.js` against a real account. Verify both succeed and the retrieved memory matches what was saved.
2. **End-to-end hook:** Use the plugin in a throwaway Claude Code session. Confirm memories are saved (check via hub dashboard) and that `evermem:search` returns results for a known query.
3. **Dashboard:** Start the proxy (`node server/proxy.js`), open the Memory Hub URL, load with a real API key. Verify: memories render, the heatmap populates, project filter works, and the "empty groups" fallback message appears when `data/groups.jsonl` is empty or missing.
4. **`evermem:debug`:** Run it and confirm the debug log shows v1 URLs and bodies, not v0.

## Out of scope

- Message batching on add (v1 allows 1–500, we keep 1).
- Switching to async `task_id` polling (we fire and forget).
- Migrating to the new senders API.
- Any dashboard UI/feature changes beyond what's needed for v1 field parsing.
- Incremental v0→v1 transition / dual-path support.

## Version bump

This is a breaking behavior change for any deployed instance still pointing at v0 — bump the plugin version to **0.2.0** as part of the merge.
