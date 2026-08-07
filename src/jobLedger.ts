import { isLocalAddress, type InterfaceAddresses } from "./comfy/target.ts";
import type { HostRegistry, ResolvedHost } from "./hosts.ts";

/**
 * Which host a job was submitted to.
 *
 * ## Why this has to exist
 *
 * comfy-cli does not attribute a job to a host. A job record carries
 * `[outputs, prompt_id, queue_position, status, updated_at, where,
 * workflow_path, workflow_size]`, and the `host`/`port` in the envelope's
 * `data` are an echo of the flag the *caller* passed, not a property of the
 * job: with no flag, `jobs ls` reports `127.0.0.1:8188`; with
 * `--host 100.86.199.90`, it reports that instead, over the same 39 records.
 *
 * Worse, asking the wrong host is not an error a caller can recognise.
 * Measured: `comfy --json jobs status <a real local id> --host 100.86.199.90
 * --port 8189` answers `prompt_not_found`, confidently — byte-identical to the
 * answer for an id that never existed. So a `get_job` that guessed at the host
 * would report a running job as missing, and there would be nothing in the
 * answer to suggest the guess was the problem.
 *
 * Hence: this server records where it sent each run, and `get_job`/`cancel_job`
 * read that back.
 *
 * ## Why it is in memory, and what that costs
 *
 * A `prompt_id` is something a caller got from `run_workflow` in this same
 * process, so the ledger is populated exactly when it is needed. Persisting it
 * would mean a second file format, its own corruption handling and its own
 * growth policy, to serve the one case where a client restarted between
 * submitting and polling — and that case already has a one-word answer, which
 * this module makes the error message say: pass `host`.
 *
 * The map is bounded because this process can outlive many runs and nothing
 * ever removes an entry: a job's id stays interesting for as long as anyone
 * might poll it, which is not a moment this server can observe.
 */

/**
 * How many submissions to remember.
 *
 * Generous against the thing it protects: a few hundred bytes each, so the
 * whole ledger is smaller than one workflow file, and 512 runs is far more
 * than one MCP session ever submits. Oldest-first eviction, because a job old
 * enough to fall out of this window has long since finished and been collected.
 */
const MAX_ENTRIES = 512;

/** Where one job was sent. */
export interface JobHost {
  /** The registry name it was submitted under, or `null` for a raw address. */
  name: string | null;
  host: string;
  port: number;
}

/**
 * Insertion-ordered by construction — `Map` iterates in insertion order, which
 * is what makes the eviction below oldest-first without a second structure.
 */
const ledger = new Map<string, JobHost>();

/** Remember where a run was submitted. */
export function recordJobHost(promptId: string, target: ResolvedHost): void {
  // Deleting first so that re-recording an id moves it to the back of the
  // eviction order rather than leaving it where it was first seen; a job being
  // submitted again is a job somebody is still interested in.
  ledger.delete(promptId);
  ledger.set(promptId, { name: target.name, host: target.host, port: target.port });

  while (ledger.size > MAX_ENTRIES) {
    const oldest = ledger.keys().next();
    if (oldest.done === true) break;
    ledger.delete(oldest.value);
  }
}

/** Where a run was submitted, or `undefined` if this process never sent it. */
export function jobHost(promptId: string): JobHost | undefined {
  return ledger.get(promptId);
}

/** Forget everything. For tests, which must not inherit each other's jobs. */
export function clearJobLedger(): void {
  ledger.clear();
}

/**
 * No `host` was given and this server cannot say which one the job is on.
 *
 * Deliberately an error rather than a guess. The default host would be a
 * *confident* answer — `prompt_not_found`, indistinguishable from a job that
 * genuinely does not exist — and a caller acting on it would conclude their
 * render had vanished while it was in fact still running somewhere else.
 */
export class JobHostUnknownError extends Error {
  override readonly name = "JobHostUnknownError";
  readonly promptId: string;
  readonly candidates: string[];

  constructor(promptId: string, candidates: string[]) {
    super(
      `this server has no record of which ComfyUI job ${promptId} was submitted to, and there is ` +
        `more than one it could be on: ${candidates.join(", ")}.\n` +
        `Pass \`host\` to say which. Attribution is remembered only for runs this server ` +
        `submitted since it started, so a job from before a restart, or one started in the ` +
        `ComfyUI web interface, always needs to be named.`,
    );
    this.promptId = promptId;
    this.candidates = candidates;
  }
}

/** Where a `get_job`/`cancel_job` should look, and how that was decided. */
export interface JobTarget {
  target: ResolvedHost;
  /** `explicit` — the caller said. `ledger` — this server remembered. `only` — there is one host. */
  source: "explicit" | "ledger" | "only";
  /**
   * Set when the caller named a host and this server remembers a different one.
   * The caller's choice is honoured — they may well be right, and this server's
   * memory does not cover a job it never submitted — but saying nothing about
   * the disagreement is how a `prompt_not_found` becomes a mystery.
   */
  contradiction: JobHost | null;
}

/**
 * Which host to ask about a job.
 *
 * The order, and why each step is where it is:
 *
 * 1. **The caller's own `host`** — always wins. This server's memory is of runs
 *    *it* submitted, and a caller polling a job started in the web interface
 *    knows something this ledger cannot.
 * 2. **The ledger** — the address this server really sent the run to.
 * 3. **The only host there is** — when the registry holds exactly one entry,
 *    there is no choice to get wrong, and refusing would break every
 *    single-host installation for a distinction that does not exist on one.
 * 4. Otherwise, refuse. See {@link JobHostUnknownError}.
 *
 * Step 3 is deliberately narrower than "fall back to the default host". The
 * default host on a two-host registry is a guess with a 50% chance of a
 * confidently wrong `prompt_not_found`; the only host on a one-host registry is
 * not a guess at all.
 */
export function resolveJobTarget(
  registry: HostRegistry,
  promptId: string,
  explicit: ResolvedHost | null,
  interfaces?: InterfaceAddresses,
): JobTarget {
  const remembered = jobHost(promptId);

  if (explicit !== null) {
    const contradicts =
      remembered !== undefined &&
      (remembered.host !== explicit.host || remembered.port !== explicit.port);
    return { target: explicit, source: "explicit", contradiction: contradicts ? remembered : null };
  }

  if (remembered !== undefined) {
    return {
      target: {
        name: remembered.name,
        host: remembered.host,
        port: remembered.port,
        // Not a property of the job, and not consulted either: `get_job` and
        // `cancel_job` never launch — a freshly started ComfyUI has no record
        // of the job being asked about.
        autoLaunch: false,
        // Recomputed rather than remembered, and it is load-bearing: this is
        // what decides whether the job's `/view` URLs get resolved to files on
        // this machine. Storing `false` here would quietly stop `get_job`
        // reporting `local_paths` for every local run.
        local:
          interfaces === undefined
            ? isLocalAddress(remembered.host)
            : isLocalAddress(remembered.host, interfaces),
        label: remembered.name ?? `${remembered.host}:${remembered.port}`,
      },
      source: "ledger",
      contradiction: null,
    };
  }

  if (registry.hosts.length === 1) {
    const only = registry.hosts[0] as HostRegistry["hosts"][number];
    return {
      target: {
        name: only.name,
        host: only.host,
        port: only.port,
        autoLaunch: false,
        local: only.local,
        label: only.name,
      },
      source: "only",
      contradiction: null,
    };
  }

  throw new JobHostUnknownError(promptId, registry.hosts.map((entry) => entry.name));
}
