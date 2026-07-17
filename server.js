#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const memory = require('./db');
const { summarize } = require('./lib/compress');

const AGENT = process.env.HIVE_MEMORY_AGENT || 'unknown-agent';
const PROJECT = process.env.HIVE_MEMORY_PROJECT || process.cwd();

const server = new Server(
  { name: 'hive-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'memory_remember',
    description: 'Store a fact or observation. scope=personal is visible only to this agent; scope=shared is visible to every agent connected to this project.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The fact/observation text' },
        key: { type: 'string', description: 'Optional short label for the entry' },
        scope: { type: 'string', enum: ['personal', 'shared', 'global'], default: 'personal' },
      },
      required: ['value'],
    },
  },
  {
    name: 'memory_recall',
    description: 'Search memory by meaning/keywords. Returns both personal (this agent only) and shared (all agents) entries unless scope is set.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['personal', 'shared'] },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_mark_outcome',
    description: 'Mark whether a previously recalled memory entry actually worked out. Improves future ranking.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        outcome: { type: 'string', enum: ['success', 'failure'] },
      },
      required: ['id', 'outcome'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Show memory statistics for this project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_recall_recent',
    description: 'Return the most relevant recent memory entries for this project without needing a search query. Useful for loading context at the start of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 20 },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === 'memory_remember') {
    const cleaned = summarize(args.value);
    const result = memory.remember({
      scope: args.scope || 'personal',
      agent: AGENT,
      project: PROJECT,
      key: args.key,
      value: cleaned,
    });
    const action = result.deduped ? 'Reinforced existing entry' : 'Stored new entry';
    return { content: [{ type: 'text', text: `${action} (id ${result.id}, scope ${args.scope || 'personal'})` }] };
  }

  if (name === 'memory_recall') {
    const rows = memory.recall({
      query: args.query,
      project: PROJECT,
      scope: args.scope,
      agent: AGENT,
      limit: args.limit || 10,
    });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No matching memories found.' }] };
    }
    const text = rows
      .map(r => `#${r.id} [${r.scope}/${r.agent}] ${r.outcome !== 'unknown' ? `(${r.outcome}) ` : ''}${r.value}`)
      .join('\n');
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'memory_mark_outcome') {
    memory.markOutcome({ id: args.id, outcome: args.outcome });
    return { content: [{ type: 'text', text: `Marked #${args.id} as ${args.outcome}` }] };
  }

  if (name === 'memory_stats') {
    const s = memory.stats({ project: PROJECT });
    return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
  }

  if (name === 'memory_recall_recent') {
    const rows = memory.recallRecent({ project: PROJECT, agent: AGENT, limit: args?.limit || 20 });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No memories yet for this project.' }] };
    }
    const text = rows
      .map(r => `#${r.id} [${r.scope}/${r.agent}] ${r.outcome !== 'unknown' ? `(${r.outcome}) ` : ''}${r.value}`)
      .join('\n');
    return { content: [{ type: 'text', text }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('hive-memory server error:', err);
  process.exit(1);
});
