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

// The hook-capture adapters spawn a brand-new `node server.js` process for
// every single event (SessionStart/UserPromptSubmit/PostToolUse/Stop) - see
// adapters/lib/remember.js. Computing an embedding there would mean loading
// the local model from scratch dozens of times per session, adding
// multi-second latency to hook events that must stay fast (some of them are
// not backgrounded and directly delay the next prompt). Only the persistent
// MCP server session (the one wired into the agent's own mcpServers config,
// which loads the model once and reuses it) does embedding work.
const LIGHTWEIGHT = process.env.HIVE_MEMORY_LIGHTWEIGHT === '1';

const server = new Server(
  { name: 'hive-memory', version: '0.7.0' },
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
        query: {
          type: 'string',
          description: 'Write this yourself, do not paste the user\'s raw message verbatim - expand abbreviations, fix likely typos, and state the actual topic in plain terms. A clean query matches stored facts far better than the user\'s literal phrasing.',
        },
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
  {
    name: 'memory_correct',
    description: 'Fix the text of an existing memory entry in place (e.g. it was wrong or went stale) instead of remembering a new, duplicate entry next to it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'id of the entry to fix (from memory_recall/memory_recall_recent output)' },
        value: { type: 'string', description: 'The corrected fact/observation text' },
      },
      required: ['id', 'value'],
    },
  },
  {
    name: 'memory_touch',
    description: 'Confirm an existing memory entry is still true/relevant right now, without changing its text. Resets its recall-ranking freshness so it keeps surfacing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'id of the entry to confirm (from memory_recall/memory_recall_recent output)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_link',
    description: 'Link two existing memory entries together (e.g. "this fact caused that failure", "this supersedes that"). Shows up when either entry is recalled.',
    inputSchema: {
      type: 'object',
      properties: {
        from_id: { type: 'number' },
        to_id: { type: 'number' },
        relation: { type: 'string', description: 'Optional short label for the relationship, e.g. "caused-by", "supersedes"' },
      },
      required: ['from_id', 'to_id'],
    },
  },
  {
    name: 'memory_convention',
    description: 'Store a project rule/standard (not a one-off fact) - e.g. a coding convention, a house rule, a "always do X" policy. Conventions always surface first in recall, regardless of recency.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The rule/convention text' },
        key: { type: 'string', description: 'Optional short label for the entry' },
        scope: { type: 'string', enum: ['personal', 'shared', 'global'], default: 'shared' },
      },
      required: ['value'],
    },
  },
  {
    name: 'memory_session_start',
    description: 'Mark the start of a new agent session (used by hook adapters; safe to call more than once for the same session_key).',
    inputSchema: {
      type: 'object',
      properties: {
        session_key: { type: 'string', description: 'Stable id for this session, e.g. the host agent\'s own session_id' },
      },
      required: ['session_key'],
    },
  },
  {
    name: 'memory_session_end',
    description: 'Mark a session as finished, with an optional short summary of what happened. Powers memory_replay for the next session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_key: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['session_key'],
    },
  },
  {
    name: 'memory_replay',
    description: 'Recap the most recently finished session for this project/agent - what happened, so a new session can pick up where the last one left off.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_skill_save',
    description: 'Save or update a reusable task recipe (a named "how to do X" procedure), distinct from a one-off fact.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short stable name to look this recipe up by, e.g. "deploy-staging"' },
        body: { type: 'string', description: 'The steps/recipe text' },
        scope: { type: 'string', enum: ['personal', 'shared', 'global'], default: 'shared' },
      },
      required: ['name', 'body'],
    },
  },
  {
    name: 'memory_skill_match',
    description: 'Find saved recipes relevant to a task, ranked by past success rate.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_skill_score',
    description: 'Record whether using a saved skill/recipe (by id, from memory_skill_match output) worked out this time. Improves future ranking.',
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
    name: 'memory_premortem',
    description: 'Before doing something risky, check memory for related past failures and conventions that could apply. Returns only failure/convention entries, not general facts.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Short, clear description of the action about to be taken, in your own words - not a copy-paste of the user\'s raw message.' },
        limit: { type: 'number', default: 8 },
      },
      required: ['action'],
    },
  },
];

function formatRow(r) {
  const tags = [r.type === 'convention' ? 'convention' : null, r.outcome !== 'unknown' ? r.outcome : null]
    .filter(Boolean)
    .map(t => `(${t})`)
    .join(' ');
  let text = `#${r.id} [${r.scope}/${r.agent}] ${tags ? tags + ' ' : ''}${r.value}`;
  const links = memory.getLinks(r.id);
  for (const l of links) {
    text += `\n    ${l.direction === 'to' ? '->' : '<-'}${l.relation ? ` ${l.relation}` : ''} #${l.other_id} ${l.other_value}`;
  }
  return text;
}

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
    if (!LIGHTWEIGHT) {
      // Best-effort: a fact is still safely stored even if embedding fails
      // (e.g. first run with no internet to fetch the local model yet).
      try {
        await memory.embedAndStore(result.id, cleaned);
      } catch (err) {
        console.error('hive-memory: embedding failed for new entry, keyword search still works:', err.message);
      }
    }
    const action = result.deduped ? 'Reinforced existing entry' : 'Stored new entry';
    return { content: [{ type: 'text', text: `${action} (id ${result.id}, scope ${args.scope || 'personal'})` }] };
  }

  if (name === 'memory_recall') {
    const recallFn = LIGHTWEIGHT ? memory.recall : memory.recallHybrid;
    const rows = await recallFn({
      query: args.query,
      project: PROJECT,
      scope: args.scope,
      agent: AGENT,
      limit: args.limit || 10,
    });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No matching memories found.' }] };
    }
    const text = rows.map(formatRow).join('\n');
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
    const text = rows.map(formatRow).join('\n');
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'memory_correct') {
    const result = memory.correctMemory({ id: args.id, value: args.value });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `No entry with id ${args.id}` }], isError: true };
    }
    if (!LIGHTWEIGHT) {
      try {
        await memory.embedAndStore(args.id, args.value);
      } catch (err) {
        console.error('hive-memory: embedding failed for corrected entry, keyword search still works:', err.message);
      }
    }
    return { content: [{ type: 'text', text: `Corrected #${args.id}` }] };
  }

  if (name === 'memory_touch') {
    const result = memory.touchMemory(args.id);
    if (!result.ok) {
      return { content: [{ type: 'text', text: `No entry with id ${args.id}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Confirmed #${args.id} still relevant` }] };
  }

  if (name === 'memory_link') {
    const result = memory.addLink({ fromId: args.from_id, toId: args.to_id, relation: args.relation });
    const text = result.created
      ? `Linked #${args.from_id} -> #${args.to_id}${args.relation ? ` (${args.relation})` : ''}`
      : `Already linked #${args.from_id} -> #${args.to_id}${args.relation ? ` (${args.relation})` : ''}`;
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'memory_convention') {
    const cleaned = summarize(args.value);
    const result = memory.remember({
      scope: args.scope || 'shared',
      agent: AGENT,
      project: PROJECT,
      key: args.key,
      value: cleaned,
      type: 'convention',
    });
    if (!LIGHTWEIGHT) {
      try {
        await memory.embedAndStore(result.id, cleaned);
      } catch (err) {
        console.error('hive-memory: embedding failed for new convention, keyword search still works:', err.message);
      }
    }
    const action = result.deduped ? 'Reinforced existing convention' : 'Stored new convention';
    return { content: [{ type: 'text', text: `${action} (id ${result.id}, scope ${args.scope || 'shared'})` }] };
  }

  if (name === 'memory_session_start') {
    memory.startSession({ sessionKey: args.session_key, agent: AGENT, project: PROJECT });
    return { content: [{ type: 'text', text: `Session ${args.session_key} started` }] };
  }

  if (name === 'memory_session_end') {
    const summary = args.summary ? summarize(args.summary) : null;
    memory.endSession({ sessionKey: args.session_key, summary });
    return { content: [{ type: 'text', text: `Session ${args.session_key} ended` }] };
  }

  if (name === 'memory_replay') {
    const session = memory.getLastEndedSession({ agent: AGENT, project: PROJECT });
    if (!session) {
      return { content: [{ type: 'text', text: 'No previous session recorded yet.' }] };
    }
    const started = new Date(session.started_at).toISOString();
    const ended = new Date(session.ended_at).toISOString();
    const text = `Previous session (${started} -> ${ended}):\n${session.summary || '(no summary recorded)'}`;
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'memory_skill_save') {
    const result = memory.skillSave({
      scope: args.scope || 'shared',
      agent: AGENT,
      project: PROJECT,
      name: args.name,
      body: args.body,
    });
    const action = result.updated ? 'Updated existing skill' : 'Saved new skill';
    return { content: [{ type: 'text', text: `${action} "${args.name}" (id ${result.id})` }] };
  }

  if (name === 'memory_skill_match') {
    const rows = memory.skillMatch({ query: args.query, project: PROJECT, agent: AGENT, limit: args.limit || 5 });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No matching skills found.' }] };
    }
    const text = rows
      .map(r => `#${r.id} [${r.scope}/${r.agent}] ${r.name} (${r.times_succeeded}/${r.times_used} succeeded)\n    ${r.body}`)
      .join('\n');
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'memory_skill_score') {
    const result = memory.skillScore({ id: args.id, outcome: args.outcome });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `No skill with id ${args.id}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Scored skill #${args.id} as ${args.outcome}` }] };
  }

  if (name === 'memory_premortem') {
    const rows = await memory.premortem({ query: args.action, project: PROJECT, agent: AGENT, limit: args.limit || 8 });
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: 'No known risks or conventions found for this - no history to flag.' }] };
    }
    const text = `Before doing this, hive-memory flags:\n${rows.map(formatRow).join('\n')}`;
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
