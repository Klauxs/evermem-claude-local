#!/usr/bin/env node
/**
 * EverMem Dashboard Proxy Server
 *
 * Serves the dashboard and proxies API requests to EverMind,
 * working around the browser limitation of not supporting GET requests with body.
 *
 * Usage: node proxy.js
 * Optional env:
 *   EVERMEM_API_URL=http://localhost:8000 node proxy.js
 *   EVERMEM_API_KEY=xxx node proxy.js
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { getRequiredUserId, getMemoryMode } from '../hooks/scripts/utils/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.EVERMEM_PROXY_PORT || 3456;
const API_BASE = process.env.EVERMEM_API_URL || 'https://api.evermind.ai';
const GROUPS_FILE = join(__dirname, '..', 'data', 'groups.jsonl');

/**
 * Compute keyId from API key (SHA-256 hash, first 12 chars)
 */
function computeKeyId(apiKey) {
  if (!apiKey) return null;
  const hash = createHash('sha256').update(apiKey).digest('hex');
  return hash.substring(0, 12);
}

/**
 * Read groups from JSONL file and filter by keyId
 */
function getGroupsForKey(keyId) {
  if (!existsSync(GROUPS_FILE)) {
    return [];
  }

  try {
    const content = readFileSync(GROUPS_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Aggregate by groupId for matching keyId
    const groupMap = new Map();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Only include entries matching this keyId
        if (entry.keyId !== keyId) continue;

        const existing = groupMap.get(entry.groupId);
        if (existing) {
          existing.sessionCount += 1;
          if (entry.timestamp > existing.lastSeen) {
            existing.lastSeen = entry.timestamp;
          }
          if (entry.timestamp < existing.firstSeen) {
            existing.firstSeen = entry.timestamp;
          }
        } else {
          groupMap.set(entry.groupId, {
            id: entry.groupId,
            name: entry.name,
            path: entry.path,
            firstSeen: entry.timestamp,
            lastSeen: entry.timestamp,
            sessionCount: 1
          });
        }
      } catch {}
    }

    // Sort by lastSeen (most recent first)
    return Array.from(groupMap.values()).sort((a, b) =>
      new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
    );
  } catch {
    return [];
  }
}

function sendCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, data) {
  sendCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getRequestAuthHeader(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader;
  }
  if (process.env.EVERMEM_API_KEY) {
    return `Bearer ${process.env.EVERMEM_API_KEY}`;
  }
  return null;
}

function buildUpstreamHeaders(authHeader) {
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }
  return headers;
}

async function postUpstreamJson(path, authHeader, body) {
  const upstream = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: buildUpstreamHeaders(authHeader),
    body: JSON.stringify(body)
  });

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!upstream.ok) {
    const error = new Error(data?.message || `Upstream error: ${upstream.status}`);
    error.status = upstream.status;
    error.payload = data;
    throw error;
  }

  return data;
}

async function fetchAllMemoryPages({ authHeader, memoryType, filters }) {
  const pageSize = 100;
  const items = [];
  let page = 1;

  while (true) {
    const payload = await postUpstreamJson('/api/v1/memories/get', authHeader, {
      memory_type: memoryType,
      filters,
      page,
      page_size: pageSize,
      rank_by: 'timestamp',
      rank_order: 'desc'
    });

    const data = payload?.data || {};
    const chunk = memoryType === 'agent_case'
      ? (data.agent_cases || [])
      : memoryType === 'agent_skill'
        ? (data.agent_skills || [])
        : (data.episodes || []);

    if (!Array.isArray(chunk) || chunk.length === 0) {
      break;
    }

    items.push(...chunk);

    const total = data.total_count ?? items.length;
    if (chunk.length < pageSize || page * pageSize >= total) {
      break;
    }

    page += 1;
  }

  return items;
}

function normalizeTimestamp(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function deriveProjectGroupId(item) {
  const sessionId = item?.session_id || '';
  if (sessionId.includes('__')) {
    return sessionId.split('__')[0];
  }
  return item?.group_id || '';
}

function normalizeHubMemory(item, memoryType) {
  const timestamp = normalizeTimestamp(item.timestamp);
  const projectGroupId = deriveProjectGroupId(item);

  if (memoryType === 'agent_case') {
    return {
      id: item.id,
      content: item.approach || item.task_intent || '',
      subject: item.task_intent || '',
      summary: item.key_insight || '',
      group_id: projectGroupId,
      raw_group_id: item.group_id || '',
      session_id: item.session_id || '',
      timestamp,
      score: item.score || item.quality_score || 0,
      memory_type: 'agent_case',
      metadata: {
        quality_score: item.quality_score,
        parent_id: item.parent_id,
        parent_type: item.parent_type,
        key_insight: item.key_insight
      }
    };
  }

  if (memoryType === 'agent_skill') {
    return {
      id: item.id,
      content: item.content || item.description || item.name || '',
      subject: item.name || item.description || 'Reusable skill',
      summary: item.description || '',
      group_id: projectGroupId || 'agent-skills',
      raw_group_id: item.group_id || '',
      session_id: item.session_id || '',
      timestamp,
      score: item.score || item.confidence || 0,
      memory_type: 'agent_skill',
      metadata: {
        confidence: item.confidence,
        maturity_score: item.maturity_score,
        cluster_id: item.cluster_id,
        description: item.description
      }
    };
  }

  return {
    id: item.id || item.message_id,
    content: item.episode || item.summary || item.content || '',
    subject: item.subject || '',
    summary: item.summary || '',
    group_id: item.group_id || '',
    raw_group_id: item.group_id || '',
    session_id: item.session_id || '',
    timestamp,
    score: item.score || 0,
    memory_type: item.memory_type || 'episodic_memory',
    metadata: {
      participants: item.participants || []
    }
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    sendCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Forward POST /api/v1/memories/{search,get} to the EverMind API
  if (req.method === 'POST' && (req.url === '/api/v1/memories/search' || req.url === '/api/v1/memories/get')) {
    (async () => {
      const authHeader = getRequestAuthHeader(req);

      try {
        const body = await readJsonBody(req);
        const headers = { 'Content-Type': 'application/json' };
        if (authHeader) {
          headers['Authorization'] = authHeader;
        }

        const upstream = await fetch(`${API_BASE}${req.url}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body)
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
    })();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/hub/memories') {
    (async () => {
      const authHeader = getRequestAuthHeader(req);

      try {
        const userId = getRequiredUserId();
        const memoryMode = getMemoryMode();
        const body = await readJsonBody(req);
        const page = Number.isInteger(body.page) && body.page > 0 ? body.page : 1;
        const pageSize = Number.isInteger(body.page_size) && body.page_size > 0 ? body.page_size : 100;
        const filters = { user_id: userId };

        let normalizedMemories = [];
        if (memoryMode === 'agent') {
          // In agent mode, also include legacy episodic memory alongside agent cases & skills.
          const [cases, skills, episodes] = await Promise.all([
            fetchAllMemoryPages({ authHeader, memoryType: 'agent_case', filters }),
            fetchAllMemoryPages({ authHeader, memoryType: 'agent_skill', filters }),
            fetchAllMemoryPages({ authHeader, memoryType: 'episodic_memory', filters })
          ]);

          normalizedMemories = [
            ...cases.map(item => normalizeHubMemory(item, 'agent_case')),
            ...skills.map(item => normalizeHubMemory(item, 'agent_skill')),
            ...episodes.map(item => normalizeHubMemory(item, 'episodic_memory'))
          ];
        } else {
          const episodes = await fetchAllMemoryPages({ authHeader, memoryType: 'episodic_memory', filters });
          normalizedMemories = episodes.map(item => normalizeHubMemory(item, 'episodic_memory'));
        }

        normalizedMemories.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const totalCount = normalizedMemories.length;
        const start = (page - 1) * pageSize;
        const pagedMemories = normalizedMemories.slice(start, start + pageSize);

        sendJson(res, 200, {
          data: {
            memories: pagedMemories,
            count: pagedMemories.length,
            total_count: totalCount,
            page,
            page_size: pageSize,
            memory_mode: memoryMode
          }
        });
      } catch (error) {
        if (error.message.includes('EVERMEM_USER_ID is required')) {
          sendJson(res, 400, {
            error: 'Missing EVERMEM_USER_ID',
            message: error.message
          });
          return;
        }

        console.error('Proxy error:', error.message);
        sendJson(res, 502, {
          error: 'Upstream request failed',
          message: error.message
        });
      }
    })();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { status: 'ok', port: PORT });
    return;
  }

  // Get groups for the current auth context
  if (req.method === 'GET' && req.url === '/api/groups') {
    const authHeader = getRequestAuthHeader(req);
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null;
    const keyId = computeKeyId(apiKey);
    const groups = getGroupsForKey(keyId);

    sendJson(res, 200, {
      status: 'ok',
      keyId,
      groups,
      totalGroups: groups.length
    });
    return;
  }

  // Serve dashboard HTML
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?') || req.url === '/dashboard' || req.url.startsWith('/dashboard?'))) {
    try {
      const dashboardPath = join(__dirname, '..', 'assets', 'dashboard.html');
      const html = readFileSync(dashboardPath, 'utf8');
      sendCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (error) {
      sendJson(res, 500, { error: 'Failed to load dashboard', message: error.message });
    }
    return;
  }

  // Serve logo
  if (req.method === 'GET' && req.url === '/logo.png') {
    try {
      const logoPath = join(__dirname, '..', 'assets', 'logo.png');
      const logo = readFileSync(logoPath);
      sendCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(logo);
    } catch (error) {
      sendJson(res, 404, { error: 'Logo not found' });
    }
    return;
  }

  // 404 for everything else
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`EverMem Dashboard Proxy running on http://localhost:${PORT}`);
  console.log('');
  console.log('The dashboard can now connect to this proxy to fetch memories.');
  console.log('Press Ctrl+C to stop.');
});
