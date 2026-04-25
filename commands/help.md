---
description: Get help with EverMem plugin setup and available commands
---

EverMem is a memory plugin for Claude Code that automatically stores and retrieves relevant context from your past coding sessions.

By default it uses EverMem's agent memory pipeline, which stores Claude Code turns as trajectories and recalls both prior cases and reusable skills.

**How it works:**
- When you chat with Claude, your conversations are automatically saved to EverMem Cloud
- When you start a new session, relevant memories from past sessions are automatically injected into context
- You can also manually search your memories using the `/evermem:search` command

First, check if the API key is configured:

```bash
if [ -n "${EVERMEM_API_KEY:-}" ]; then
  echo "STATUS: Configured"
  echo "Auth: API key configured"
  echo "API Key: ${EVERMEM_API_KEY:0:10}..."
  echo "API URL: ${EVERMEM_API_URL:-https://api.evermind.ai}"
elif [ -n "${EVERMEM_API_URL:-}" ]; then
  echo "STATUS: Configured"
  echo "Auth: No API key configured"
  echo "API URL: ${EVERMEM_API_URL}"
  echo "Mode: Custom/local server (works only if the server accepts unauthenticated requests)"
else
  echo "STATUS: Not configured"
  echo ""
  echo "To get started:"
  echo "1. For EverMem Cloud: visit https://console.evermind.ai/ to get your API key"
  echo "2. Add one of these to your shell config (~/.zshrc or ~/.bashrc):"
  echo "   export EVERMEM_API_KEY=\"your_api_key_here\""
  echo "   export EVERMEM_API_URL=\"http://localhost:8000\""
  echo "3. Restart Claude Code"
fi

echo "Memory Mode: ${EVERMEM_MEMORY_MODE:-agent}"
```

Present the configuration status to the user. If not configured, guide them through the setup steps.

**Available Commands:**

| Command | Description |
|---------|-------------|
| `/evermem:help` | Show this help message |
| `/evermem:search <query>` | Search your memories for specific topics |
| `/evermem:hub` | Open the Memory Hub dashboard to visualize and explore memories |
| `/evermem:debug` | View debug logs for troubleshooting |
| `/evermem:projects` | View your Claude Code projects table |

**Automatic Features:**
- **Memory Retrieved**: When you submit a prompt, relevant agent cases and skills are automatically retrieved and shown
- **Memory Save**: When Claude finishes responding, the turn is automatically saved as an agent trajectory

Share this information with the user in a clear, helpful format.
