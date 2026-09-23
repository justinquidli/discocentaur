/**
 * Graceful shutdown. On SIGINT/SIGTERM: stop taking messages, let any transfer
 * already in flight finish (up to graceMs), then exit.
 *
 * Why: pm2 restarts by sending SIGINT and, if the process is still alive after
 * kill_timeout, SIGKILL. Scheduled-drop timers keep the event loop alive, so
 * without this every deploy ended in SIGKILL — and a deploy that landed while a
 * drop was being submitted could kill the bot after the transfer went out but
 * before it was recorded or reported. graceMs must stay below pm2's
 * kill_timeout (see ecosystem.config.cjs) or pm2 kills us first.
 *
 * Side-effect free until install() is called, so tests can import it.
 * Shared byte-for-byte between TeleCentaur and DiscoCentaur.
 */

export const SHUTDOWN_GRACE_MS = 10_000;

export function createShutdown({ graceMs = SHUTDOWN_GRACE_MS, logger = console, exit = (code) => process.exit(code) } = {}) {
  const inflight = new Set();
  const stopHooks = [];
  let stopping = false;
  let done = null;

  return {
    /** True once a signal has arrived. New money actions should be refused. */
    get stopping() { return stopping; },
    get inflightCount() { return inflight.size; },

    /** Registers work that must finish before exit. Returns the same promise. */
    track(promise, label = 'action') {
      const entry = { promise: Promise.resolve(promise), label };
      inflight.add(entry);
      entry.promise.then(() => inflight.delete(entry), () => inflight.delete(entry));
      return promise;
    },

    /** Runs first on shutdown — stop polling / close the gateway here. */
    onStop(fn) { stopHooks.push(fn); },

    shutdown(signal = 'shutdown') {
      if (done) return done;
      stopping = true;
      done = (async () => {
        logger.log(`[shutdown] ${signal} — no new messages; waiting for ${inflight.size} in-flight action(s)`);
        for (const fn of stopHooks) {
          try { await fn(signal); } catch (err) { logger.error('[shutdown] stop hook failed:', err?.message ?? err); }
        }
        let timer;
        const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(true), graceMs); });
        const drained = (async () => {
          // Loop: an action can start another (a turn that was mid-tool-loop).
          while (inflight.size) await Promise.allSettled([...inflight].map((e) => e.promise));
          return false;
        })();
        const late = await Promise.race([drained, timedOut]);
        clearTimeout(timer);
        if (late) {
          logger.error(`[shutdown] ⚠️  still running after ${graceMs} ms, exiting anyway: ${[...inflight].map((e) => e.label).join(', ')}`);
        } else {
          logger.log('[shutdown] clean exit');
        }
        exit(0);
      })();
      return done;
    },

    install(proc = process) {
      proc.once('SIGINT', () => this.shutdown('SIGINT'));
      proc.once('SIGTERM', () => this.shutdown('SIGTERM'));
    },
  };
}
