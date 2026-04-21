#!/usr/bin/env node

/**
 * Test script for saving memories to EverMem Cloud
 * Simulates typical Claude Code conversations
 *
 * Usage:
 *   export EVERMEM_API_KEY="your-key"
 *   node scripts/test-save-memories.js
 */

import { getConfig, isConfigured } from '../hooks/scripts/utils/config.js';
import { addMemory, addAgentTrajectory, flushAgentMemories } from '../hooks/scripts/utils/evermem-api.js';

// Sample conversations that might happen in Claude Code
const TEST_CONVERSATIONS = [
  {
    user: "I need to set up authentication for our API. What approach should we use?",
    assistant: "For your API authentication, I recommend using JWT (JSON Web Tokens) with short-lived access tokens (15 minutes) and longer-lived refresh tokens stored in httpOnly cookies. This provides a good balance of security and user experience. The refresh tokens in httpOnly cookies protect against XSS attacks, while the short access token lifetime limits the damage if a token is compromised."
  },
  {
    user: "We're getting a lot of N+1 query issues in the user listing endpoint",
    assistant: "I've identified the N+1 query problem. The issue is in the UserService.getAllUsers() method where we're loading user roles in a loop. I've fixed it by adding eager loading with a JOIN query. Changed from individual role queries per user to a single query with LEFT JOIN on the roles table. This reduced the query count from 101 queries to just 2 queries for 100 users."
  },
  {
    user: "What database should we use for this project?",
    assistant: "Based on your requirements for complex queries and transactions, I recommend PostgreSQL. It offers excellent support for JSON fields if you need schema flexibility, strong ACID compliance, and great performance for read-heavy workloads with proper indexing. We should also set up connection pooling with a max of 20 connections to handle concurrent requests efficiently."
  },
  {
    user: "The API is throwing rate limit errors in production",
    assistant: "I've implemented rate limiting using Redis with a sliding window algorithm. The configuration is: 100 requests per minute for authenticated users, 20 requests per minute for anonymous users. The rate limiter returns 429 Too Many Requests with a Retry-After header. I've also added the express-rate-limit middleware with the Redis store for distributed rate limiting across multiple server instances."
  },
  {
    user: "How should we handle errors in the API?",
    assistant: "I've set up a centralized error handling middleware. All errors now follow a consistent format: { status: 'error', code: 'ERROR_CODE', message: 'Human readable message', details: {} }. We use custom error classes (ValidationError, NotFoundError, AuthenticationError) that extend a base AppError. Unhandled errors are logged to our monitoring service and return a generic 500 response to avoid leaking implementation details."
  }
];

async function main() {
  console.log('🧪 EverMem Save Memory Test\n');
  console.log('=' .repeat(50));

  // Check configuration
  if (!isConfigured()) {
    console.error('❌ EVERMEM_API_KEY not set');
    console.error('   Run: export EVERMEM_API_KEY="your-key"');
    process.exit(1);
  }

  const config = getConfig();
  console.log(`✓ API Key: ${config.apiKey ? `${config.apiKey.slice(0, 10)}...` : 'Not configured (using API URL only)'}`);
  console.log(`✓ User ID: ${config.userId}`);
  console.log(`✓ Group ID: ${config.groupId}`);
  console.log(`✓ API URL: ${config.apiBaseUrl}`);
  console.log('=' .repeat(50));
  console.log('');

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < TEST_CONVERSATIONS.length; i++) {
    const conv = TEST_CONVERSATIONS[i];
    console.log(`\n📝 Conversation ${i + 1}/${TEST_CONVERSATIONS.length}`);
    console.log(`   User: "${conv.user.slice(0, 50)}..."`);

    if (config.memoryMode === 'agent') {
      try {
        const timestamp = Date.now();
        const sessionId = `${config.groupId}__test-save`;
        const result = await addAgentTrajectory({
          sessionId,
          messages: [
            {
              role: 'user',
              timestamp,
              content: conv.user,
              sender_id: config.userId,
              sender_name: config.userId
            },
            {
              role: 'assistant',
              timestamp: timestamp + 1,
              content: conv.assistant,
              sender_id: 'claude-assistant',
              sender_name: 'Claude'
            }
          ]
        });
        const flush = await flushAgentMemories({ sessionId });
        console.log(`   ✓ Agent trajectory saved (add: ${result.status}, flush: ${flush.response?.data?.status || 'unknown'})`);
        successCount += 2;
      } catch (error) {
        console.log(`   ❌ Agent trajectory failed: ${error.message}`);
        failCount += 2;
      }
      continue;
    }

    // Save user message
    try {
      const userResult = await addMemory({
        content: conv.user,
        role: 'user',
        messageId: `test_user_${Date.now()}_${i}`
      });
      console.log(`   ✓ User message saved (status: ${userResult.status || 'ok'})`);
      successCount++;
    } catch (error) {
      console.log(`   ❌ User message failed: ${error.message}`);
      if (error.response) {
        console.log(`      Response: ${JSON.stringify(error.response)}`);
      }
      failCount++;
    }

    // Save assistant message
    try {
      const assistantResult = await addMemory({
        content: conv.assistant,
        role: 'assistant',
        messageId: `test_assistant_${Date.now()}_${i}`
      });
      console.log(`   ✓ Assistant message saved (status: ${assistantResult.status || 'ok'})`);
      successCount++;
    } catch (error) {
      console.log(`   ❌ Assistant message failed: ${error.message}`);
      if (error.response) {
        console.log(`      Response: ${JSON.stringify(error.response)}`);
      }
      failCount++;
    }
  }

  console.log('\n' + '=' .repeat(50));
  console.log(`\n✅ Done! ${successCount} saved, ${failCount} failed`);
  console.log('\nNow run the retrieval test:');
  console.log('   node scripts/test-retrieve-memories.js');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
