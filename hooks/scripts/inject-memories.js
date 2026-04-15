#!/usr/bin/env node

/**
 * Memory Plugin - UserPromptSubmit Hook
 *
 * This hook automatically injects relevant memories from past sessions ，
 * into Claude's context when the user submits a prompt.
 *
 * Flow:
 * 1. Read prompt from stdin
 * 2. Skip if prompt is too short or API not configured
 * 3. Search EverMem Cloud for relevant memories
 * 4. Optionally filter with Claude SDK
 * 5. Display summary to user (via systemMessage)
 * 6. Inject context for Claude (via additionalContext)
 */

import { isConfigured, getConfig } from './utils/config.js';
import { searchMemories, transformSearchResults } from './utils/evermem-api.js';
import { formatRelativeTime } from './utils/mock-store.js';
import { debug, setDebugPrefix } from './utils/debug.js';

// Set debug prefix for this script
setDebugPrefix('inject');

const MIN_WORDS = 3;
const LOCAL_SCORE_THRESHOLD = 0.1;   // In-project: lenient, keep most results
const GLOBAL_SCORE_THRESHOLD = 0.5;  // Cross-project: strict, only high relevance
const MAX_LOCAL_MEMORIES = 5;        // Max in-project results
const MAX_GLOBAL_MEMORIES = 3;       // Max cross-project results

/**
 * Count words/tokens in a string (multilingual support)
 * - For CJK (Chinese/Japanese/Korean): counts each character as a token
 * - For other languages: counts space-separated words
 * - For mixed text: counts both
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  // Regex for CJK characters (Chinese, Japanese Kanji, Korean Hanja)
  // Also includes Japanese Hiragana/Katakana and Korean Hangul
  const cjkRegex = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g;

  // Count CJK characters
  const cjkMatches = trimmed.match(cjkRegex);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remove CJK characters and count remaining space-separated words
  const nonCjkText = trimmed.replace(cjkRegex, ' ').trim();
  const wordCount = nonCjkText ? nonCjkText.split(/\s+/).filter(w => w.length > 0).length : 0;

  return cjkCount + wordCount;
}

/**
 * Main hook handler
 */
async function main() {
  try {
    // Read stdin
    const input = await readStdin();
    const data = JSON.parse(input);
    const prompt = data.prompt || '';

    debug('hookInput:', data);

    // Set cwd from hook input for config.getGroupId()
    if (data.cwd) {
      process.env.EVERMEM_CWD = data.cwd;
    }

    // Skip short prompts silently
    const wordCount = countWords(prompt);
    if (wordCount < MIN_WORDS) {
      debug('skipped: prompt too short', { wordCount, minWords: MIN_WORDS });
      process.exit(0);
    }

    // Skip if not configured (silent - don't nag users)
    if (!isConfigured()) {
      debug('skipped: not configured');
      process.exit(0);
    }

    // Global search + client-side tiered filtering
    const { localMemories, globalMemories } = await searchAndFilter(prompt);

    if (localMemories.length === 0 && globalMemories.length === 0) {
      debug('skipped: no relevant memories above thresholds');
      process.exit(0);
    }

    // Build context for Claude
    const context = buildContext({ localMemories, globalMemories });

    // Build display message for user
    const displayMessage = buildDisplayMessage(localMemories, globalMemories);

    // Output JSON with systemMessage (user display) and additionalContext (for Claude)
    const output = {
      systemMessage: displayMessage,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context
      }
    };

    debug('output:', { systemMessage: displayMessage, contextLength: context.length });
    process.stdout.write(JSON.stringify(output));
    process.exit(0);

  } catch (error) {
    // Silent on errors - don't block user workflow
    debug('error:', error.message);
    process.exit(0);
  }
}

/**
 * Read all stdin input
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', chunk => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data);
    });

    process.stdin.on('error', reject);
  });
}

/**
 * Single global search + client-side tiered filtering.
 * All memories are fetched in one API call, then split by group_id
 * with different score thresholds for local vs cross-project results.
 */
async function searchAndFilter(prompt) {
  const config = getConfig();

  let allMemories = [];
  try {
    debug('searching memories for prompt:', prompt.slice(0, 100) + (prompt.length > 100 ? '...' : ''));
    const apiResponse = await searchMemories(prompt, {
      topK: 15,
      retrieveMethod: 'hybrid',
      memoryTypes: ['episodic_memory']
    });
    allMemories = transformSearchResults(apiResponse);
    debug('global search results:', { total: allMemories.length });
  } catch (error) {
    debug('search error:', error.message);
    return { localMemories: [], globalMemories: [] };
  }

  // Split by group_id: current project vs other projects
  const currentGroupId = config.groupId;
  const localRaw = [];
  const globalRaw = [];

  for (const m of allMemories) {
    if (m.metadata.groupId === currentGroupId) {
      localRaw.push(m);
    } else {
      globalRaw.push(m);
    }
  }

  // Apply different score thresholds
  const localMemories = localRaw
    .filter(m => m.score >= LOCAL_SCORE_THRESHOLD)
    .slice(0, MAX_LOCAL_MEMORIES);

  const globalMemories = globalRaw
    .filter(m => m.score >= GLOBAL_SCORE_THRESHOLD)
    .slice(0, MAX_GLOBAL_MEMORIES);

  debug('filtered:', {
    local: { raw: localRaw.length, filtered: localMemories.length, threshold: LOCAL_SCORE_THRESHOLD },
    global: { raw: globalRaw.length, filtered: globalMemories.length, threshold: GLOBAL_SCORE_THRESHOLD }
  });

  return { localMemories, globalMemories };
}

/**
 * Build display message for user (shown via systemMessage)
 */
function buildDisplayMessage(localMemories, globalMemories = []) {
  const total = localMemories.length + globalMemories.length;
  const header = `📝 Memory Retrieved (${total}):`;
  const lines = [header];

  for (const memory of localMemories) {
    const relTime = formatRelativeTime(memory.timestamp);
    const score = memory.score ? memory.score.toFixed(2) : '0.00';
    const title = memory.subject ||
      (memory.text.length > 60 ? memory.text.slice(0, 60) + '...' : memory.text);
    lines.push(`  • [${score}] (${relTime}) ${title}`);
  }

  if (globalMemories.length > 0) {
    lines.push(`  ── cross-project ──`);
    for (const memory of globalMemories) {
      const relTime = formatRelativeTime(memory.timestamp);
      const score = memory.score ? memory.score.toFixed(2) : '0.00';
      const source = memory.metadata.groupId || 'other';
      const title = memory.subject ||
        (memory.text.length > 50 ? memory.text.slice(0, 50) + '...' : memory.text);
      lines.push(`  • [${score}] (${relTime}) [${source}] ${title}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build context string for Claude with tiered local/global sections
 */
function buildContext({ localMemories, globalMemories }) {
  const lines = [];
  lines.push('<relevant-memories>');
  lines.push('IMPORTANT: Memories are ordered by recency. When conflicts exist, prefer MORE RECENT information.');
  lines.push('');

  // Current project memories (high confidence)
  if (localMemories.length > 0) {
    lines.push('## Current Project Memories:');
    const sorted = [...localMemories].sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    for (const m of sorted) {
      const timeStr = formatTimestamp(m.timestamp);
      const typeTag = m.memoryType !== 'episodic_memory'
        ? ` [${m.memoryType}]` : '';
      lines.push(`[${timeStr}]${typeTag} ${m.text}`);
      lines.push('');
    }
  }

  // Cross-project memories (labeled with source, caution advised)
  if (globalMemories.length > 0) {
    lines.push('## Cross-Project Memories (from other projects, use with caution):');
    const sorted = [...globalMemories].sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    for (const m of sorted) {
      const timeStr = formatTimestamp(m.timestamp);
      const source = m.metadata.groupId || 'unknown-project';
      const score = m.score ? m.score.toFixed(2) : '0.00';
      lines.push(`[${timeStr}] [source: ${source}] [score: ${score}] ${m.text}`);
      lines.push('');
    }
    lines.push('Note: Cross-project memories may not directly apply. Verify relevance before using.');
  }

  lines.push('</relevant-memories>');
  return lines.join('\n');
}

function formatTimestamp(ts) {
  if (!ts) return 'Unknown time';
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC'
  }) + ' UTC';
}

// Run
main();
