#!/usr/bin/env node
// Shared helper for the claude-code and cursor adapters: opens a one-shot MCP
// stdio connection to the hive-memory server and calls memory_remember.
// No storage/search logic lives here - it only speaks the MCP protocol to
// the existing server.js.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');
const TIMEOUT_MS = 10000;

// Opens a one-shot MCP stdio connection to the hive-memory server, does the
// initialize handshake, calls a single tool, and resolves with its raw
// result. Shared by rememberViaMcp (write) and recallRecentViaMcp (read) -
// same process/handshake mechanics, different tool name/args.
function callMcpTool({ agent, project }, toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    // These hook-triggered calls spawn a fresh server.js per event and must
    // stay fast - HIVE_MEMORY_LIGHTWEIGHT skips embedding computation there
    // (see server.js). The persistent MCP server used for real searches
    // isn't spawned through this helper, so it's unaffected.
    const env = { ...process.env, HIVE_MEMORY_AGENT: agent, HIVE_MEMORY_LIGHTWEIGHT: '1' };
    if (project) env.HIVE_MEMORY_PROJECT = project;

    const child = spawn('node', [SERVER_PATH], { env, stdio: ['pipe', 'pipe', 'ignore'] });

    let buffer = '';
    let awaitingCallResult = false;

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('hive-memory MCP call timed out'));
    }, TIMEOUT_MS);

    function send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }

        if (!awaitingCallResult && msg.id === 1) {
          // initialize responded - complete handshake, then call the tool.
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: toolName, arguments: toolArgs },
          });
          awaitingCallResult = true;
        } else if (awaitingCallResult && msg.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve(msg.result);
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hive-memory-capture', version: '0.1.0' },
      },
    });
  });
}

function rememberViaMcp({ agent, project, value, key, scope = 'personal' }) {
  return callMcpTool({ agent, project }, 'memory_remember', { value, key, scope });
}

function recallRecentViaMcp({ agent, project, limit }) {
  return callMcpTool({ agent, project }, 'memory_recall_recent', { limit });
}

module.exports = { rememberViaMcp, recallRecentViaMcp };
