---
description: View EverMem debug logs to troubleshoot memory saving and retrieval issues
---

# EverMem Debug Log Viewer

View the EverMem debug log to troubleshoot issues.

## Instructions

Show the user the recent debug log entries from the platform-specific debug log path:
- Windows: `%TEMP%\\evermem-debug.log`
- macOS/Linux: `/tmp/evermem-debug.log`

1. First check if debug mode is enabled by looking for `EVERMEM_DEBUG=1` in the plugin's `.env` file
2. Resolve the correct debug log path for the current OS
3. Read the last 50 lines of the debug log file
4. If the file doesn't exist or is empty, inform the user how to enable debug mode

## Actions

1. Check debug mode status:
   ```bash
   grep "EVERMEM_DEBUG" /path/to/plugin/.env 2>/dev/null || echo "Not configured"
   ```

2. Resolve log path and show recent logs:
   ```bash
   LOG_PATH="$(node -e 'const path=require("path"); process.stdout.write(process.platform === "win32" ? path.join(process.env.TEMP || process.env.TMP || "C:/Windows/Temp", "evermem-debug.log") : "/tmp/evermem-debug.log")')"
   printf '%s\n' "$LOG_PATH"
   tail -50 "$LOG_PATH" 2>/dev/null || echo "No debug log found"
   ```

3. Format the output for the user, highlighting:
   - `[inject]` entries for memory retrieval
   - `[store]` entries for memory saving
   - Any errors or warnings

## Output Format

```
📋 EverMem Debug Log

Status: Debug mode [ENABLED/DISABLED]
Log file: [resolved path]

--- Recent Entries ---
[timestamp] [inject] ...
[timestamp] [store] ...

--- Tips ---
• Enable debug: Add EVERMEM_DEBUG=1 to .env
• Windows log path: %TEMP%\\evermem-debug.log
• macOS/Linux log path: /tmp/evermem-debug.log
```

## Additional Options

If the user specifies arguments:
- `clear` - Clear the debug log
- `live` - Show command for live monitoring
- `full` - Show more lines (100+)
- `inject` - Filter to show only [inject] entries
- `store` - Filter to show only [store] entries
