#!/usr/bin/env node

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

import { readFileSync, existsSync } from 'fs';
import { isConfigured, getConfig } from './utils/config.js';
import { addMemory, addAgentTrajectory, flushAgentMemories } from './utils/evermem-api.js';
import { debug, setDebugPrefix } from './utils/debug.js';

setDebugPrefix('store');

function hasContent(text) {
  return text && text.trim().length > 0;
}

function stripInjectedContext(text) {
  if (!text) return text;
  return text
    .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, '')
    .replace(/<session-context>[\s\S]*?<\/session-context>/g, '')
    .trim();
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function readTranscriptWithRetry(path, maxRetries = 5, delayMs = 100) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const content = readFileSync(path, 'utf8');
    const lines = content.trim().split('\n');

    let isComplete = false;
    try {
      const lastLine = JSON.parse(lines[lines.length - 1]);
      isComplete = lastLine.type === 'system' && lastLine.subtype === 'turn_duration';
    } catch {}

    debug(`read attempt ${attempt}:`, {
      totalLines: lines.length,
      isComplete,
      lastLineType: (() => {
        try {
          const entry = JSON.parse(lines[lines.length - 1]);
          return entry.subtype ? `${entry.type}/${entry.subtype}` : entry.type;
        } catch {
          return 'unknown';
        }
      })()
    });

    if (isComplete) {
      return lines;
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return readFileSync(path, 'utf8').trim().split('\n');
}

function getCurrentTurnRange(lines) {
  const turnEndIndex = lines.length;
  let turnStartIndex = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === 'system' && entry.subtype === 'turn_duration') {
        turnStartIndex = i + 1;
        break;
      }
    } catch {}
  }

  return { turnStartIndex, turnEndIndex };
}

function contentItemsToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    } else if (typeof block.text === 'string') {
      texts.push(block.text);
    } else if (typeof block.content === 'string') {
      texts.push(block.content);
    }
  }
  return texts.join('\n\n').trim();
}

function getEntryTimestampMs(entry, fallback = Date.now()) {
  if (!entry?.timestamp) {
    return fallback;
  }

  if (typeof entry.timestamp === 'number') {
    return entry.timestamp;
  }

  const parsed = new Date(entry.timestamp).getTime();
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') {
    return stripInjectedContext(content);
  }

  if (Array.isArray(content)) {
    const text = contentItemsToText(content);
    if (text) {
      return stripInjectedContext(text);
    }
  }

  if (!content) {
    return '';
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractLastTurnText(lines) {
  const { turnStartIndex, turnEndIndex } = getCurrentTurnRange(lines);
  const userTexts = [];
  const assistantTexts = [];

  for (let i = turnStartIndex; i < turnEndIndex; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      const content = entry.message?.content;

      if (entry.type === 'user') {
        if (typeof content === 'string') {
          userTexts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              userTexts.push(block.text);
            }
          }
        }
      }

      if (entry.type === 'assistant') {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              assistantTexts.push(block.text);
            }
          }
        } else if (typeof content === 'string') {
          assistantTexts.push(content);
        }
      }
    } catch {}
  }

  return {
    user: userTexts.join('\n\n'),
    assistant: assistantTexts.join('\n\n')
  };
}

function extractAgentTurnMessages(lines, config) {
  const { turnStartIndex, turnEndIndex } = getCurrentTurnRange(lines);
  const messages = [];

  for (let i = turnStartIndex; i < turnEndIndex; i++) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const timestamp = getEntryTimestampMs(entry, Date.now() + i);
    const content = entry.message?.content;

    if (entry.type === 'user') {
      if (typeof content === 'string') {
        const text = stripInjectedContext(content);
        if (hasContent(text)) {
          messages.push({
            role: 'user',
            timestamp,
            content: text,
            sender_id: config.userId,
            sender_name: config.userId
          });
        }
        continue;
      }

      if (Array.isArray(content)) {
        const userText = stripInjectedContext(contentItemsToText(content.filter(block => block?.type === 'text')));
        if (hasContent(userText)) {
          messages.push({
            role: 'user',
            timestamp,
            content: userText,
            sender_id: config.userId,
            sender_name: config.userId
          });
        }

        for (const block of content) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) {
            continue;
          }

          const toolText = normalizeToolResultContent(block.content);
          if (!hasContent(toolText)) {
            continue;
          }

          messages.push({
            role: 'tool',
            timestamp,
            tool_call_id: block.tool_use_id,
            content: toolText,
            sender_id: block.name || 'tool',
            sender_name: block.name || 'tool'
          });
        }
      }
    }

    if (entry.type === 'assistant') {
      if (typeof content === 'string') {
        const text = stripInjectedContext(content);
        if (hasContent(text)) {
          messages.push({
            role: 'assistant',
            timestamp,
            content: text,
            sender_id: 'claude-assistant',
            sender_name: 'Claude'
          });
        }
        continue;
      }

      if (Array.isArray(content)) {
        const textBlocks = [];
        const toolCalls = [];

        for (const block of content) {
          if (block?.type === 'text' && block.text) {
            textBlocks.push({ type: 'text', text: block.text });
          }

          if (block?.type === 'tool_use' && block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {})
              }
            });
          }
        }

        const text = stripInjectedContext(contentItemsToText(textBlocks));
        if (hasContent(text) || toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            timestamp,
            content: hasContent(text) ? text : '',
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            sender_id: 'claude-assistant',
            sender_name: 'Claude'
          });
        }
      }
    }
  }

  return messages;
}

function buildAgentSessionId(config, rawSessionId) {
  return `${config.groupId}__${rawSessionId || 'default'}`;
}

async function saveEpisodicTurn(lines) {
  const lastTurn = extractLastTurnText(lines);
  const cleanUser = stripInjectedContext(lastTurn.user);
  const cleanAssistant = stripInjectedContext(lastTurn.assistant);
  const results = [];
  const skipped = [];

  if (cleanUser) {
    if (hasContent(cleanUser)) {
      const len = cleanUser.length;
      try {
        const result = await addMemory({ content: cleanUser, role: 'user', messageId: `u_${Date.now()}` });
        results.push({ type: 'USER', len, ...result });
      } catch (error) {
        results.push({ type: 'USER', len, ok: false, error: error.message });
      }
    } else {
      skipped.push({ type: 'USER', reason: 'whitespace-only content' });
    }
  }

  if (cleanAssistant) {
    if (hasContent(cleanAssistant)) {
      const len = cleanAssistant.length;
      try {
        const result = await addMemory({ content: cleanAssistant, role: 'assistant', messageId: `a_${Date.now()}` });
        results.push({ type: 'ASSISTANT', len, ...result });
      } catch (error) {
        results.push({ type: 'ASSISTANT', len, ok: false, error: error.message });
      }
    } else {
      skipped.push({ type: 'ASSISTANT', reason: 'whitespace-only content' });
    }
  }

  const allSuccess = results.length > 0 && results.every(result => result.ok && !result.error);

  if (allSuccess) {
    const details = results.map(result => `${result.type.toLowerCase()}: ${result.len}`).join(', ');
    let output = `💾 Memory saved (${results.length}) [${details}]`;
    if (skipped.length > 0) {
      output += `\n⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}`;
    }
    return { systemMessage: output };
  }

  if (results.length === 0 && skipped.length > 0) {
    return {
      systemMessage: `⏭️ EverMem: No content to save\n${skipped.map(item => `  • ${item.type}: ${item.reason}`).join('\n')}`
    };
  }

  let output = '💾 EverMem: Save failed\n';
  for (const result of results) {
    if (result.error) {
      output += `${result.type}: ERROR - ${result.error}\n`;
    } else if (!result.ok) {
      output += `${result.type}: FAILED (${result.status})\n`;
      output += `Request: ${JSON.stringify(result.body, null, 2)}\n`;
      output += `Response: ${JSON.stringify(result.response, null, 2)}\n`;
    }
  }
  if (skipped.length > 0) {
    output += `⏭️ Skipped: ${skipped.map(item => `${item.type} (${item.reason})`).join(', ')}\n`;
  }
  return { systemMessage: output };
}

async function saveAgentTurn(lines, config, hookInput) {
  const agentMessages = extractAgentTurnMessages(lines, config);
  const sessionId = buildAgentSessionId(config, hookInput.session_id || hookInput.sessionId);

  debug('agent messages extracted:', {
    count: agentMessages.length,
    sessionId,
    roles: agentMessages.map(msg => msg.role)
  });

  if (agentMessages.length === 0) {
    return null;
  }

  const addResult = await addAgentTrajectory({ sessionId, messages: agentMessages });
  const flushResult = addResult.ok
    ? await flushAgentMemories({ sessionId })
    : null;

  if (addResult.ok && flushResult?.ok) {
    const toolCallCount = agentMessages.reduce((count, msg) => count + (msg.tool_calls?.length || 0), 0);
    const flushStatus = flushResult.response?.data?.status || 'unknown';
    return {
      systemMessage: `💾 Agent memory saved (${agentMessages.length} msgs, ${toolCallCount} tools, flush: ${flushStatus})`
    };
  }

  let output = '💾 EverMem: Agent save failed\n';
  if (!addResult.ok) {
    output += `add: ${JSON.stringify(addResult.response, null, 2)}\n`;
  }
  if (flushResult && !flushResult.ok) {
    output += `flush: ${JSON.stringify(flushResult.response, null, 2)}\n`;
  }
  return { systemMessage: output };
}

try {
  const input = await readStdin();
  const hookInput = JSON.parse(input);
  debug('hookInput:', hookInput);

  const transcriptPath = hookInput.transcript_path;
  if (hookInput.cwd) {
    process.env.EVERMEM_CWD = hookInput.cwd;
  }

  if (!transcriptPath || !existsSync(transcriptPath) || !isConfigured()) {
    process.exit(0);
  }

  const config = getConfig();
  const lines = await readTranscriptWithRetry(transcriptPath);

  debug('last 3 lines types:', lines.slice(-3).map((line, idx) => {
    try {
      const entry = JSON.parse(line);
      return { index: lines.length - 3 + idx, type: entry.type, subtype: entry.subtype, hasContent: !!entry.message?.content };
    } catch {
      return { index: lines.length - 3 + idx, error: 'parse failed' };
    }
  }));

  const output = config.memoryMode === 'agent'
    ? await saveAgentTurn(lines, config, hookInput)
    : await saveEpisodicTurn(lines);

  if (output?.systemMessage) {
    process.stdout.write(JSON.stringify(output));
  }
} catch {
  process.exit(0);
}
