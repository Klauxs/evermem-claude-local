/**
 * EverMem Cloud API client
 * Handles memory search and storage operations
 */

import { getConfig, getRequiredUserId } from './config.js';
import { debug, setDebugPrefix } from './debug.js';

// Set debug prefix for this script
setDebugPrefix('EverMemAPI');
const TIMEOUT_MS = 30000; // 30 seconds

function buildHeaders(config) {
  return config.apiKey
    ? { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

function getDefaultSearchMemoryTypes(config) {
  return config.memoryMode === 'agent' ? ['agent_memory'] : ['episodic_memory'];
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

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
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
  }

  const {
    topK = 15,
    retrieveMethod = 'hybrid',
    memoryTypes = getDefaultSearchMemoryTypes(config)
  } = options;

  const url = `${config.apiBaseUrl}/api/v1/memories/search`;
  // Always search by user_id for global scope (cross-project recall)
  const filters = { user_id: config.userId };

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
      headers: buildHeaders(config),
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

/**
 * Transform v1 search API response to plugin memory format.
 * v1 returns: { data: { episodes: [{ id, user_id, session_id, timestamp, summary, subject, score, participants, group_id? }], ... } }
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories sorted by score desc
 */
export function transformSearchResults(apiResponse) {
  const data = apiResponse?.data || {};
  const memories = [];

  if (Array.isArray(data.episodes)) {
    for (const ep of data.episodes) {
      const content = ep.summary || ep.episode || '';
      if (!content) continue;

      memories.push({
        text: content,
        subject: ep.subject || '',
        timestamp: normalizeTimestamp(ep.timestamp),
        memoryType: ep.memory_type || 'episodic_memory',
        score: ep.score || 0,
        sessionId: ep.session_id,
        metadata: {
          groupId: ep.group_id,
          type: ep.memory_type,
          participants: ep.participants
        }
      });
    }
  }

  const agentMemory = data.agent_memory || {};

  if (Array.isArray(agentMemory.cases)) {
    for (const agentCase of agentMemory.cases) {
      const text = agentCase.approach || agentCase.task_intent || '';
      if (!text) continue;

      memories.push({
        text,
        subject: agentCase.task_intent || '',
        timestamp: normalizeTimestamp(agentCase.timestamp),
        memoryType: 'agent_case',
        score: agentCase.score || 0,
        sessionId: agentCase.session_id,
        metadata: {
          groupId: agentCase.group_id,
          type: 'agent_case',
          qualityScore: agentCase.quality_score,
          parentId: agentCase.parent_id,
          parentType: agentCase.parent_type,
          keyInsight: agentCase.key_insight
        }
      });
    }
  }

  if (Array.isArray(agentMemory.skills)) {
    for (const skill of agentMemory.skills) {
      const text = skill.content || skill.description || skill.name || '';
      if (!text) continue;

      memories.push({
        text,
        subject: skill.name || skill.description || '',
        timestamp: normalizeTimestamp(skill.timestamp),
        memoryType: 'agent_skill',
        score: skill.score || skill.confidence || 0,
        sessionId: skill.session_id,
        metadata: {
          groupId: skill.group_id,
          type: 'agent_skill',
          confidence: skill.confidence,
          maturityScore: skill.maturity_score,
          clusterId: skill.cluster_id,
          description: skill.description
        }
      });
    }
  }

  memories.sort((a, b) => b.score - a.score);
  return memories;
}


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
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
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
      headers: buildHeaders(config),
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

/**
 * Add an agent trajectory to EverMemOS.
 * @param {Object} payload
 * @param {Object[]} payload.messages - Agent trajectory messages
 * @param {string} [payload.sessionId] - Claude session identifier
 * @returns {Promise<Object>} Debug envelope
 */
export async function addAgentTrajectory(payload) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
  }

  const url = `${config.apiBaseUrl}/api/v1/memories/agent`;
  const requestBody = {
    user_id: config.userId,
    messages: payload.messages
  };

  if (payload.sessionId) {
    requestBody.session_id = payload.sessionId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody)
  });

  const responseText = await response.text();
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  return {
    url,
    body: requestBody,
    status: response.status,
    ok: response.ok,
    response: responseData
  };
}

/**
 * Flush buffered agent messages to force memory extraction.
 * @param {Object} payload
 * @param {string} [payload.sessionId] - Claude session identifier
 * @returns {Promise<Object>} Debug envelope
 */
export async function flushAgentMemories(payload = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
  }

  const url = `${config.apiBaseUrl}/api/v1/memories/agent/flush`;
  const requestBody = {
    user_id: config.userId
  };

  if (payload.sessionId) {
    requestBody.session_id = payload.sessionId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody)
  });

  const responseText = await response.text();
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = responseText;
  }

  return {
    url,
    body: requestBody,
    status: response.status,
    ok: response.ok,
    response: responseData
  };
}

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
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
  }

  const {
    page = 1,
    pageSize = 100,
    memoryType = config.memoryMode === 'agent' ? 'agent_case' : 'episodic_memory'
  } = options;

  const filters = options.filters || (
    memoryType === 'agent_case' || memoryType === 'agent_skill'
      ? { user_id: config.userId }
      : (config.groupId ? { group_id: config.groupId } : { user_id: config.userId })
  );

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
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return await response.json();
}

export async function getMemoriesByUser(options = {}) {
  const config = getConfig();

  if (!config.isConfigured) {
    throw new Error('EverMem not configured. Set EVERMEM_API_KEY or EVERMEM_API_URL');
  }

  const userId = getRequiredUserId();
  const {
    page = 1,
    pageSize = 100,
    memoryType = 'episodic_memory'
  } = options;

  const url = `${config.apiBaseUrl}/api/v1/memories/get`;
  const requestBody = {
    memory_type: memoryType,
    filters: { user_id: userId },
    page,
    page_size: pageSize,
    rank_by: 'timestamp',
    rank_order: 'desc'
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error ${response.status}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Transform v1 getMemories response to simple format.
 * @param {Object} apiResponse - Raw v1 API response
 * @returns {Object[]} Formatted memories newest-first
 */
export function transformGetMemoriesResults(apiResponse) {
  const data = apiResponse?.data || {};
  const memories = [];

  if (Array.isArray(data.episodes)) {
    memories.push(...data.episodes.map(ep => ({
      text: ep.episode || ep.summary || '',
      subject: ep.subject || '',
      timestamp: normalizeTimestamp(ep.timestamp),
      groupId: ep.group_id,
      sessionId: ep.session_id,
      memoryType: ep.memory_type || 'episodic_memory'
    })).filter(m => m.text));
  }

  if (Array.isArray(data.agent_cases)) {
    memories.push(...data.agent_cases.map(agentCase => ({
      text: agentCase.approach || agentCase.task_intent || '',
      subject: agentCase.task_intent || '',
      timestamp: normalizeTimestamp(agentCase.timestamp),
      groupId: agentCase.group_id,
      sessionId: agentCase.session_id,
      memoryType: 'agent_case',
      qualityScore: agentCase.quality_score
    })).filter(m => m.text));
  }

  if (Array.isArray(data.agent_skills)) {
    memories.push(...data.agent_skills.map(skill => ({
      text: skill.content || skill.description || skill.name || '',
      subject: skill.name || skill.description || '',
      timestamp: normalizeTimestamp(skill.timestamp),
      groupId: skill.group_id,
      sessionId: skill.session_id,
      memoryType: 'agent_skill',
      confidence: skill.confidence
    })).filter(m => m.text));
  }

  memories.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return memories;
}
