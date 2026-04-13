# EverMem v1 API Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-cut migrate the `evermem` plugin from the deprecated v0 EverMind Cloud API to v1, across the hook API client, dashboard proxy, dashboard HTML, MCP server, test scripts, and README.

**Architecture:** All external network calls live in three files — `hooks/scripts/utils/evermem-api.js` (used by hooks, commands, MCP, test scripts), `server/proxy.js` (used by the dashboard), and `assets/dashboard.html` (the dashboard itself). Rewriting those three files updates every call site transitively. The public function contracts of `evermem-api.js` (`addMemory`, `searchMemories`, `getMemories`, `transformSearchResults`, `transformGetMemoriesResults`) are **preserved**, so callers in `store-memories.js`, `inject-memories.js`, `session-context.js`, `search-memories.js`, and `mcp/server.js` need **no changes**.

**Tech Stack:** Node.js 18+ ESM, native `fetch`, zero test framework (smoke scripts in `scripts/` only).

**Spec:** `docs/superpowers/specs/2026-04-13-evermem-v1-api-upgrade-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `hooks/scripts/utils/evermem-api.js` | Rewrite | All 4 functions call v1 endpoints; transforms read v1 response shapes. |
| `server/proxy.js` | Modify | Drop v0 curl handlers; add generic v1 POST-JSON forwarder for `/api/v1/memories/search` and `/api/v1/memories/get`. |
| `assets/dashboard.html` | Modify | `fetchAllMemories()` iterates `/api/groups` then paginates `POST /api/v1/memories/get` per group; `transformApiResponse()` reads `data.episodes[]`. |
| `scripts/test-save-memories.js` | No code change | Calls `addMemory()` unchanged (contract preserved). |
| `scripts/test-retrieve-memories.js` | No code change | Calls `searchMemories()`/`transformSearchResults()` unchanged. |
| `mcp/server.js` | No change | Uses `searchMemories()`/`transformSearchResults()` unchanged. |
| `hooks/scripts/store-memories.js`, `inject-memories.js`, `session-context.js`, `commands/scripts/search-memories.js` | No change | Use preserved public functions. |
| `README.md` | Modify | Replace v0 endpoint references with v1; update architecture notes. |
| `plugin.json` | Modify | Version bump `0.1.3` → `0.2.0`. |

No new files. No file splits. All existing boundaries retained.

---

## Preconditions

- [ ] **Pre-0: Verify working directory & environment**

```bash
cd /Users/hzh/code/memory-plugin
git status
test -n "$EVERMEM_API_KEY" && echo "key set" || echo "KEY MISSING - export EVERMEM_API_KEY=... before running smoke tests"
node --version
```

Expected: clean working tree, `key set`, Node ≥ 18.

---

### Task 1: Rewrite `searchMemories` to v1

**Files:**
- Modify: `hooks/scripts/utils/evermem-api.js:37-109`

- [ ] **Step 1: Replace the `searchMemories` function body**

Open `hooks/scripts/utils/evermem-api.js`. Replace the entire `export async function searchMemories(...)` block (currently lines 37-109) with the version below. The function signature, options shape, and return envelope stay the same so every caller keeps working.

```js
/**
 * Search memories from EverMem Cloud (v1)
 * @param {string} query - Search query text
 * @param {Object} options - Additional options
 * @param {number} options.topK - Max results (default: 10)
 * @param {string} options.retrieveMethod - Search method: keyword|vector|hybrid|agentic (default: 'hybrid')
 * @param {string[]} options.memoryTypes - Memory types (default: ['episodic_memory'])
 * @returns {Promise<Object>} Raw API response with _debug envelope
 */
export async function searchMemories(query, options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem API key not configured');
  }

  const {
    topK = 10,
    retrieveMethod = 'hybrid',
    memoryTypes = ['episodic_memory']
  } = options;

  const url = `${config.apiBaseUrl}/api/v1/memories/search`;
  const filters = config.groupId
    ? { group_id: config.groupId }
    : { user_id: config.userId };

  const requestBody = {
    query,
    method: retrieveMethod,
    top_k: topK,
    memory_types: memoryTypes,
    filters
  };

  debug('searchMemories request body', requestBody);

  const debugEnvelope = {
    url,
    requestBody,
    apiKeyMasked: 'API_KEY_HIDDEN'
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { _debug: { ...debugEnvelope, status: response.status, rawBody: text, error: 'non-JSON response' } };
    }

    if (!response.ok) {
      return { _debug: { ...debugEnvelope, status: response.status, error: data } };
    }

    data._debug = debugEnvelope;
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`API timeout after ${TIMEOUT_MS}ms`);
    }
    return { _debug: { ...debugEnvelope, error: error.message } };
  }
}
```

- [ ] **Step 2: Remove the unused `execSync` import if nothing else uses it**

Inside `hooks/scripts/utils/evermem-api.js`, check whether any other function references `execSync`. After Task 1, the only call site is gone; keep the import for now (it is harmless) and revisit at Task 4 self-review.

---

### Task 2: Rewrite `transformSearchResults` for v1 response shape

**Files:**
- Modify: `hooks/scripts/utils/evermem-api.js:111-151`

- [ ] **Step 1: Replace `transformSearchResults`**

v1 search returns `data.episodes[]`, with content in `ep.summary` (renamed from v0's `episode`). The shape returned to callers (`{text, subject, timestamp, memoryType, score, metadata}`) is preserved so `inject-memories.js`, `mcp/server.js`, and the search command keep working.

```js
/**
 * Transform v1 search API response to plugin memory format.
 * v1 returns: { data: { episodes: [{ id, user_id, session_id, timestamp, summary, subject, score, participants, group_id? }], ... } }
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories sorted by score desc
 */
export function transformSearchResults(apiResponse) {
  const episodes = apiResponse?.data?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }

  const memories = [];
  for (const ep of episodes) {
    const content = ep.summary || '';
    if (!content) continue;

    memories.push({
      text: content,
      subject: ep.subject || '',
      timestamp: ep.timestamp || new Date().toISOString(),
      memoryType: ep.memory_type || 'episodic_memory',
      score: ep.score || 0,
      metadata: {
        groupId: ep.group_id,
        type: ep.memory_type,
        participants: ep.participants
      }
    });
  }

  memories.sort((a, b) => b.score - a.score);
  return memories;
}
```

- [ ] **Step 2: Commit Tasks 1 + 2 together**

```bash
git add hooks/scripts/utils/evermem-api.js
git commit -m "feat(api): migrate searchMemories to v1 POST /api/v1/memories/search"
```

---

### Task 3: Rewrite `addMemory` to v1

**Files:**
- Modify: `hooks/scripts/utils/evermem-api.js:162-213`

- [ ] **Step 1: Replace the `addMemory` function body**

v1 batches messages under `messages[]`, uses unix-ms integer timestamps, and splits personal vs group into different paths. We keep the external one-call-per-message cadence; each call sends a `messages` array of length 1. The external return envelope (`{url, body, status, ok, response}`) is preserved.

```js
/**
 * Add a memory to EverMem Cloud (v1).
 * Uses /api/v1/memories/group when config.groupId is set, else /api/v1/memories (personal).
 * @param {Object} message - Message to store
 * @param {string} message.content - Message content
 * @param {string} message.role - 'user' or 'assistant'
 * @param {string} [message.messageId] - (unused in v1; accepted for backward compatibility)
 * @returns {Promise<Object>} Debug envelope { url, body, status, ok, response }
 */
export async function addMemory(message) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem API key not configured');
  }

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const sender_id = role === 'assistant' ? 'claude-assistant' : config.userId;

  const baseMessage = {
    sender_id,
    role,
    timestamp: Date.now(),
    content: message.content
  };

  let url;
  let requestBody;

  if (config.groupId) {
    url = `${config.apiBaseUrl}/api/v1/memories/group`;
    requestBody = {
      group_id: config.groupId,
      messages: [baseMessage],
      async_mode: true
    };
  } else {
    url = `${config.apiBaseUrl}/api/v1/memories`;
    requestBody = {
      user_id: config.userId,
      messages: [baseMessage],
      async_mode: true
    };
  }

  let response, responseText, responseData, status, ok;

  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    status = response.status;
    ok = response.ok;
    responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {}
  } catch (fetchError) {
    status = 0;
    ok = false;
    responseText = fetchError.message;
  }

  return {
    url,
    body: requestBody,
    status,
    ok,
    response: responseData || responseText
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add hooks/scripts/utils/evermem-api.js
git commit -m "feat(api): migrate addMemory to v1 /api/v1/memories{,/group}"
```

---

### Task 4: Rewrite `getMemories` and `transformGetMemoriesResults` to v1

**Files:**
- Modify: `hooks/scripts/utils/evermem-api.js:224-299`

- [ ] **Step 1: Replace `getMemories`**

v1 list is `POST /api/v1/memories/get` with a JSON body (not query params). Filter uses `group_id` when available (group memories are not indexed by `user_id`), else `user_id`. Contract preserved: same `{page, pageSize, memoryType}` option shape, same raw-envelope return for `transformGetMemoriesResults` to consume.

```js
/**
 * Get memories from EverMem Cloud (v1, ordered newest first by default).
 * @param {Object} options - Options
 * @param {number} options.page - Page number (default: 1)
 * @param {number} options.pageSize - Results per page (default: 100, max: 100)
 * @param {string} options.memoryType - Memory type filter (default: 'episodic_memory')
 * @returns {Promise<Object>} Raw v1 response { data: { episodes, total_count, count, ... } }
 */
export async function getMemories(options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem API key not configured');
  }

  const {
    page = 1,
    pageSize = 100,
    memoryType = 'episodic_memory'
  } = options;

  const filters = config.groupId
    ? { group_id: config.groupId }
    : { user_id: config.userId };

  const url = `${config.apiBaseUrl}/api/v1/memories/get`;
  const requestBody = {
    memory_type: memoryType,
    filters,
    page,
    page_size: pageSize,
    rank_by: 'timestamp',
    rank_order: 'desc'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return await response.json();
}
```

- [ ] **Step 2: Replace `transformGetMemoriesResults`**

v1 get returns `data.episodes[]` with content in `ep.episode` (coincidentally the same field name as v0 search used). Contract preserved: returns `[{text, subject, timestamp, groupId}]` sorted newest-first.

```js
/**
 * Transform v1 getMemories response to simple format.
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories newest-first
 */
export function transformGetMemoriesResults(apiResponse) {
  const episodes = apiResponse?.data?.episodes;
  if (!Array.isArray(episodes)) {
    return [];
  }

  const memories = episodes.map(ep => ({
    text: ep.episode || ep.summary || '',
    subject: ep.subject || '',
    timestamp: ep.timestamp || new Date().toISOString(),
    groupId: ep.group_id
  })).filter(m => m.text);

  memories.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return memories;
}
```

- [ ] **Step 3: Remove the now-unused `execSync` import**

At the top of `hooks/scripts/utils/evermem-api.js`, delete this line:

```js
import { execSync } from 'child_process';
```

No other function in the file uses it after Tasks 1-4.

- [ ] **Step 4: Sanity check with node — parse-only**

```bash
node --check hooks/scripts/utils/evermem-api.js
```

Expected: no output (exit 0). Any syntax error aborts the task.

- [ ] **Step 5: Commit**

```bash
git add hooks/scripts/utils/evermem-api.js
git commit -m "feat(api): migrate getMemories to v1 POST /api/v1/memories/get"
```

---

### Task 5: Smoke-test the hook API client end-to-end

**Files:** none changed

- [ ] **Step 1: Run the save smoke script**

```bash
EVERMEM_DEBUG=1 node scripts/test-save-memories.js
```

Expected: all 10 messages report `status: 200` or `202`, zero failures. If a call returns `status: 422`, read the JSON response for the schema error and fix the corresponding field in `addMemory` (Task 3) before continuing.

- [ ] **Step 2: Wait for extraction, then run the retrieve smoke script**

Async mode queues extraction server-side. Wait ~30 seconds, then:

```bash
sleep 30 && node scripts/test-retrieve-memories.js
```

Expected: at least 3 of the 7 queries return ≥1 memory. Scores should be numeric, `text` non-empty, `timestamp` parseable. Zero hard errors.

- [ ] **Step 3: Tail the debug log to verify v1 URLs**

```bash
tail -n 40 ~/.evermem-debug.log | grep -E "v0|v1" | head
```

Expected: only `/api/v1/...` URLs, zero `/api/v0/...` references.

---

### Task 6: Rewrite the proxy to forward v1

**Files:**
- Modify: `server/proxy.js:107-173`

- [ ] **Step 1: Delete both v0 curl-forwarder blocks**

Remove the two `if` blocks:
- `if (req.method === 'POST' && req.url === '/api/v0/memories') { ... }` (lines 107-139)
- `if (req.method === 'POST' && req.url === '/api/v0/memories/search') { ... }` (lines 141-173)

- [ ] **Step 2: Insert a generic v1 forwarder in their place**

In the same spot (after the CORS preflight block, before the `/health` handler), insert:

```js
  // Forward POST /api/v1/memories/{search,get} to the EverMind API
  if (req.method === 'POST' && (req.url === '/api/v1/memories/search' || req.url === '/api/v1/memories/get')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });

    req.on('end', async () => {
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        sendJson(res, 401, { error: 'Missing Authorization header' });
        return;
      }

      try {
        const upstream = await fetch(`${API_BASE}${req.url}`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          },
          body
        });

        const text = await upstream.text();
        sendCorsHeaders(res);
        res.writeHead(upstream.status, {
          'Content-Type': upstream.headers.get('content-type') || 'application/json'
        });
        res.end(text);
      } catch (error) {
        console.error('Proxy error:', error.message);
        sendJson(res, 502, {
          error: 'Upstream request failed',
          message: error.message
        });
      }
    });
    return;
  }
```

- [ ] **Step 3: Remove the now-unused `execSync` import**

At the top of `server/proxy.js`, delete:

```js
import { execSync } from 'child_process';
```

- [ ] **Step 4: Syntax check**

```bash
node --check server/proxy.js
```

Expected: exit 0.

- [ ] **Step 5: Boot the proxy and health-check it**

```bash
node server/proxy.js &
PROXY_PID=$!
sleep 1
curl -s http://localhost:3456/health
kill $PROXY_PID
```

Expected: `{"status":"ok","port":3456}`.

- [ ] **Step 6: Commit**

```bash
git add server/proxy.js
git commit -m "feat(proxy): replace v0 curl forwarders with v1 fetch forwarder"
```

---

### Task 7: Update the dashboard fetch logic to v1

**Files:**
- Modify: `assets/dashboard.html:754-795` (`fetchAllMemories`)
- Modify: `assets/dashboard.html:902-930` (`transformApiResponse`)

- [ ] **Step 1: Replace `fetchAllMemories` with a groups-driven v1 fetcher**

v1 filters require a real `group_id` or `user_id`. Group memories are indexed by group, so iterate the local `/api/groups` list and paginate each one with `POST /api/v1/memories/get`. This matches how the plugin writes (one group per project working directory).

Find the function starting at line 754 (`async function fetchAllMemories() {`) and replace the entire function (up to and including its closing brace at line 795) with:

```js
    async function fetchAllMemories() {
      // 1. Get the list of local groups for this API key
      const groupsResponse = await fetch(`${PROXY_URL}/api/groups`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });

      if (!groupsResponse.ok) {
        throw new Error(`Failed to load groups: ${groupsResponse.status} ${groupsResponse.statusText}`);
      }

      const groupsData = await groupsResponse.json();
      const groups = groupsData.groups || [];

      if (groups.length === 0) {
        // No locally-tracked groups → nothing to show. v1 requires a concrete filter
        // (user_id or group_id), so there is no "fetch everything" path.
        return { data: { episodes: [] } };
      }

      // 2. For each group, paginate /api/v1/memories/get
      const allEpisodes = [];
      const PAGE_SIZE = 100;

      for (const group of groups) {
        let page = 1;
        while (true) {
          const response = await fetch(`${PROXY_URL}/api/v1/memories/get`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              memory_type: 'episodic_memory',
              filters: { group_id: group.id },
              page,
              page_size: PAGE_SIZE,
              rank_by: 'timestamp',
              rank_order: 'desc'
            })
          });

          if (!response.ok) {
            if (page === 1) {
              const errorData = await response.json().catch(() => ({}));
              // Surface error only for the first failure per group, then skip it
              console.warn(`Group ${group.id} failed:`, errorData.message || response.status);
            }
            break;
          }

          const payload = await response.json();
          const episodes = payload?.data?.episodes || [];
          if (episodes.length === 0) break;

          // Attach group_id to each episode so the UI can filter/label by project
          for (const ep of episodes) {
            if (!ep.group_id) ep.group_id = group.id;
          }
          allEpisodes.push(...episodes);

          const total = payload?.data?.total_count ?? Infinity;
          if (episodes.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
          page += 1;
        }
      }

      return { data: { episodes: allEpisodes } };
    }
```

- [ ] **Step 2: Update `transformApiResponse` to read v1 shape**

Find the function starting at `function transformApiResponse(apiResponse) {` (line 902). The full current function is approximately 30 lines and ends at the next top-level `function`. Replace it with:

```js
    function transformApiResponse(apiResponse) {
      const episodes = apiResponse?.data?.episodes;
      if (!Array.isArray(episodes)) return [];

      return episodes.map((ep, i) => {
        // v1 get → content in ep.episode; v1 search → content in ep.summary.
        // Accept both so this transform works regardless of upstream endpoint.
        const content = ep.episode || ep.summary || ep.content || '';
        const timestamp = ep.timestamp || ep.create_time || new Date().toISOString();
        const date = new Date(timestamp);

        return {
          id: ep.id || ep.message_id || `mem_${i}`,
          content,
          subject: ep.subject || '',
          groupId: ep.group_id || '',
          participants: ep.participants || [],
          timestamp,
          date: formatLocalDate(date),
```

Keep the rest of the return object (the remaining fields after `date:` — `dateKey`, `time`, etc.) **exactly as it was** — do not delete lines below the `date: formatLocalDate(date),` line you just wrote. Verify with:

```bash
grep -n "dateKey\|participants: ep.participants\|function transformApiResponse" assets/dashboard.html | head
```

Expected: one `function transformApiResponse` line, one `participants:` line referencing `ep.`, and the rest of the mapping (dateKey, etc.) still present.

- [ ] **Step 3: Check HTML is still valid JS inside the script block**

```bash
node --input-type=module -e "import('fs').then(fs => fs.readFileSync('assets/dashboard.html', 'utf8'))"
```

(File is HTML so node can't parse it directly; this only verifies read. For a real check:)

```bash
# Extract the main <script> block and syntax-check it
node -e "
  const fs = require('fs');
  const html = fs.readFileSync('assets/dashboard.html', 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!match) { console.error('no script block found'); process.exit(1); }
  require('vm').createScript(match[1], { filename: 'dashboard-inline.js' });
  console.log('OK');
"
```

Expected: `OK`. Any `SyntaxError` means the replacement broke something — re-read the edited region and fix before committing.

- [ ] **Step 4: Browser smoke test**

```bash
node server/proxy.js &
PROXY_PID=$!
sleep 1
echo "Open http://localhost:3456/?key=$EVERMEM_API_KEY in a browser"
echo "Verify: memories load, timeline renders, project filter populated."
echo "Press Enter when verified..."
read
kill $PROXY_PID
```

Expected manual result: memories appear. If the groups list is empty for this API key, the dashboard shows the existing "No Memories Found" empty state — acceptable.

- [ ] **Step 5: Commit**

```bash
git add assets/dashboard.html
git commit -m "feat(dashboard): fetch v1 memories per group via /api/v1/memories/get"
```

---

### Task 8: Update README

**Files:**
- Modify: `README.md` (all v0 references — grep locates them)

- [ ] **Step 1: Find every v0 reference**

```bash
grep -n "api/v0\|/v0/\|GET /api/v0\|POST /api/v0\|GET with body\|fetch doesn't support GET" README.md
```

- [ ] **Step 2: Apply these replacements across the README**

Use Edit/search-replace. Canonical mapping:

| Old | New |
|---|---|
| `POST /api/v0/memories` (store) | `POST /api/v1/memories` or `POST /api/v1/memories/group` |
| `GET /api/v0/memories/search` | `POST /api/v1/memories/search` |
| `GET /api/v0/memories` (list) | `POST /api/v1/memories/get` |
| `GET with body` / "fetch doesn't support GET with body" rationale | Remove — v1 uses POST everywhere. Replace with: "The proxy forwards browser calls to the EverMind API and serves the dashboard." |
| Any line mentioning v0 in the ASCII architecture diagram | rewrite to v1 equivalents |

- [ ] **Step 3: Verify no v0 references remain**

```bash
grep -n "/v0/\|api/v0" README.md
```

Expected: empty output.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README endpoint references to v1"
```

---

### Task 9: Version bump & final verification

**Files:**
- Modify: `plugin.json:3` (version field)

- [ ] **Step 1: Bump the version**

Edit `plugin.json`. Change `"version": "0.1.3"` to `"version": "0.2.0"`.

- [ ] **Step 2: Re-run smoke tests end-to-end**

```bash
node scripts/test-save-memories.js && sleep 30 && node scripts/test-retrieve-memories.js
```

Expected: save succeeds (all 10 status 200/202), retrieve returns memories for at least 3 queries.

- [ ] **Step 3: Re-run dashboard smoke test**

```bash
node server/proxy.js &
PROXY_PID=$!
sleep 1
# Open http://localhost:3456/?key=$EVERMEM_API_KEY in a browser
echo "Verify memories render in the dashboard. Enter to continue."
read
kill $PROXY_PID
```

- [ ] **Step 4: Confirm zero v0 references remain in code or docs**

```bash
grep -rn "api/v0\|/v0/" \
  hooks/ server/ assets/ mcp/ scripts/ commands/ README.md plugin.json \
  2>/dev/null | grep -v node_modules
```

Expected: empty output.

- [ ] **Step 5: Commit the version bump**

```bash
git add plugin.json
git commit -m "chore: bump plugin version to 0.2.0 for v1 API migration"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - `evermem-api.js` — Tasks 1-4 ✓
  - `proxy.js` — Task 6 ✓
  - `dashboard.html` — Task 7 ✓
  - README — Task 8 ✓
  - Version bump — Task 9 ✓
  - `scripts/test-*.js` — no change needed (contract preserved); covered by Task 5/9 smoke runs ✓
  - `mcp/server.js` — no change needed (contract preserved) ✓
  - Group handling, personal fallback — Task 3 ✓
  - Response-shape split (search=`summary`, get=`episode`) — Tasks 2, 4, 7 ✓
- **Placeholder scan:** no TBDs, no "add error handling", all code blocks complete.
- **Type consistency:** `config.groupId`, `config.userId`, `config.apiBaseUrl`, `config.apiKey` — match `hooks/scripts/utils/config.js`. `data.episodes[]` envelope used in Tasks 2, 4, 7. `sender_id` string matches v1 schema. Function contracts (`addMemory`/`searchMemories`/`getMemories` signatures + return envelopes) preserved across tasks.
- **No new unit-test framework added:** Project has no test framework; smoke scripts are the acceptance gate (Tasks 5, 9). This is consistent with existing project conventions.
