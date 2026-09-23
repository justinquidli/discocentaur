/**
 * Which Connect MCP tools the model may see, and keeping that set current
 * while the bot runs.
 *
 * Side-effect free so it can be imported by tests (bot.js connects on import).
 * Shared byte-for-byte between TeleCentaur and DiscoCentaur — edit in one repo,
 * then `npm run sync-shared`.
 *
 * The bots speak one-shot JSON-RPC to a stateless server, so they never hear
 * `notifications/tools/list_changed`. Instead tools/list is re-read on a timer
 * and the MCP half of the tool array is swapped in place.
 */

// Fallback for a Connect MCP older than the annotations. If the server
// annotates nothing we cannot tell a read from a spend, so we offer exactly the
// tools we always have rather than guessing from the name.
export const MCP_LEGACY_ALLOWLIST = new Set(['connect_drop_balance', 'connect_scores_batch', 'connect_lookup', 'connect_lookup_exposed', 'connect_me']);

// Write tools the model may call, but which never run without the user's
// explicit /confirm (Telegram) or !confirm (Discord) — document or not. Named
// one by one on purpose: a new write tool from Connect stays withheld until
// someone decides it belongs here.
export const MCP_CONFIRM_TOOLS = new Set(['connect_trust_create', 'connect_trust_revoke']);

// Write tools offered to the model as Connect defines them and forwarded as-is.
// connect_drop is how the bot sends; it follows the same hold rules as every
// other money tool (MONEY_TOOLS in held-actions.js).
export const MCP_SEND_TOOLS = new Set(['connect_drop']);

export const MCP_REFRESH_MS = 10 * 60 * 1000;

/**
 * Decides which discovered tools the model may see. This is the gate that keeps
 * the money path away from the model, so it must never change without a test.
 *
 * A server that annotates ANY tool is treated as annotation-capable, so an
 * unannotated tool from that server is withheld — fail closed. A tool marked
 * readOnlyHint:false is withheld unless it is named in MCP_CONFIRM_TOOLS.
 */
export function selectMcpTools(offered) {
  const list = Array.isArray(offered) ? offered : [];
  const annotated = list.some((t) => typeof t?.annotations?.readOnlyHint === 'boolean');
  const register = [];
  const skipped = [];
  for (const t of list) {
    if (!t?.name) continue;
    const ro = t.annotations?.readOnlyHint;
    const allow = annotated
      ? ro === true || (ro === false && (MCP_CONFIRM_TOOLS.has(t.name) || MCP_SEND_TOOLS.has(t.name)))
      : MCP_LEGACY_ALLOWLIST.has(t.name);
    (allow ? register : skipped).push(t);
  }
  return { register, skipped: skipped.map((t) => t.name), annotated };
}

const signature = (t) => JSON.stringify([t.description ?? '', t.inputSchema ?? null]);

/**
 * Owns the MCP entries inside the bot's `tools` array and the `names` set the
 * dispatcher checks. Both are mutated in place, so every reference the bot
 * already holds stays live.
 *
 * refresh() never leaves the bot worse off than before: on a failed or empty
 * tools/list it keeps the last good set. A tool whose name collides with a
 * hardcoded one is skipped rather than allowed to shadow it.
 *
 * @param {object} o
 * @param {Array}  o.tools      the bot's tool array ({ name, description, input_schema })
 * @param {() => Promise<{tools?: Array}>} o.listTools  one tools/list call
 * @param {{log: Function, error: Function}} [o.logger]
 */
export function createMcpRegistry({ tools, listTools, logger = console }) {
  const names = new Set();
  const sigs = new Map();
  let inFlight = null;
  let timer = null;
  let firstRun = true;

  async function doRefresh() {
    let discovered;
    try {
      discovered = await listTools();
    } catch (err) {
      logger.error(`[mcp] tool refresh failed, keeping ${names.size} tool(s):`, err?.message ?? err);
      return { ok: false, added: [], removed: [], changed: [] };
    }
    const { register, skipped, annotated } = selectMcpTools(discovered?.tools ?? []);
    if (!annotated && firstRun) {
      logger.error('[mcp] ⚠️  server sent no readOnlyHint annotations — falling back to the legacy allowlist. Upgrade Connect MCP to auto-register new tools.');
    }
    const local = new Set(tools.filter((t) => !names.has(t.name)).map((t) => t.name));
    const next = register.filter((t) => {
      if (!local.has(t.name)) return true;
      logger.error(`[mcp] ⚠️  ${t.name} collides with a hardcoded tool — not registered`);
      return false;
    });
    if (next.length === 0 && names.size > 0) {
      logger.error(`[mcp] ⚠️  tools/list returned nothing usable — keeping the previous ${names.size} tool(s)`);
      return { ok: false, added: [], removed: [], changed: [] };
    }

    const nextNames = new Set(next.map((t) => t.name));
    const added = next.filter((t) => !names.has(t.name)).map((t) => t.name);
    const removed = [...names].filter((n) => !nextNames.has(n));
    const changed = next.filter((t) => names.has(t.name) && sigs.get(t.name) !== signature(t)).map((t) => t.name);

    if (added.length || removed.length || changed.length) {
      for (let i = tools.length - 1; i >= 0; i--) if (names.has(tools[i].name)) tools.splice(i, 1);
      names.clear();
      sigs.clear();
      for (const t of next) {
        tools.push({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema });
        names.add(t.name);
        sigs.set(t.name, signature(t));
      }
    }

    if (firstRun) {
      // A tool we have always offered that no longer arrives means Connect
      // renamed it, pulled it, or stopped marking it read-only.
      const missing = [...MCP_LEGACY_ALLOWLIST].filter((n) => !names.has(n));
      if (missing.length) logger.error(`[mcp] ⚠️  expected but NOT registered: ${missing.join(', ')}`);
      if (skipped.length) logger.log(`   Connect MCP: withheld (${annotated ? 'not read-only' : 'not in the legacy allowlist'}): ${skipped.join(', ')}`);
      logger.log(`   Connect MCP: ${names.size ? [...names].join(', ') : 'no tools registered'}`);
      const gated = [...names].filter((n) => MCP_CONFIRM_TOOLS.has(n));
      if (gated.length) logger.log(`   Connect MCP: need confirmation: ${gated.join(', ')}`);
    } else if (added.length || removed.length || changed.length) {
      logger.log(`[mcp] tools updated — added: ${added.join(', ') || '-'}; removed: ${removed.join(', ') || '-'}; changed: ${changed.join(', ') || '-'}`);
      logger.log(`   Connect MCP: ${[...names].join(', ')}`);
    }
    firstRun = false;
    return { ok: true, added, removed, changed };
  }

  return {
    names,
    /** Overlapping calls share one tools/list. */
    refresh() {
      if (!inFlight) inFlight = doRefresh().finally(() => { inFlight = null; });
      return inFlight;
    },
    start(intervalMs = MCP_REFRESH_MS) {
      if (timer) return;
      timer = setInterval(() => { this.refresh(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
