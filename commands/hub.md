---
description: Open the EverMem Memory Hub to view statistics, search memories, and explore timeline
---

When the user runs this command:

1. First, start the proxy server in the background using the Bash tool:
```bash
node "${CLAUDE_PLUGIN_ROOT}/server/proxy.js" &
```

2. Then, construct the Memory Hub URL using Bash. If `EVERMEM_API_KEY` is set, include it in the URL. Otherwise, return the plain local URL:
```bash
if [ -n "${EVERMEM_API_KEY:-}" ]; then
	echo "http://localhost:3456/?key=${EVERMEM_API_KEY}"
else
	echo "http://localhost:3456/"
fi
```

3. Share a simple message with the user like:
"Memory Hub server started. Open this URL to view your memories:
[the URL from step 2]"

Do NOT show the bash commands or code blocks to the user. Just run them and share the final URL.
