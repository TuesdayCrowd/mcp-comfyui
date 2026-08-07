import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import { fetchArtifacts, type FetchedArtifact } from "./comfy/fetchOutputs.ts";
import { fetchRemoteWorkflow, listRemoteWorkflows } from "./comfy/userdata.ts";
import {
  detectInstance,
  ensureInstance,
  launchInstance,
  type LaunchArgs,
  type RunningInstance,
} from "./comfy/instance.ts";
import { cancelJob, getJobStatus, type CancelResult, type JobStatus } from "./comfy/jobs.ts";
import {
  resolveArtifactPaths,
  type ArtifactLocation,
  type ClassifiedOutputs,
} from "./comfy/outputs.ts";
import {
  cacheRoot,
  getObjectInfo,
  objectInfoCachePath,
  ObjectInfoFetchError,
} from "./comfy/objectInfo.ts";
import {
  ALLOW_LAUNCH_ENV,
  AUTO_LAUNCH_ENV,
  CACHE_DIR_ENV,
  HOST_ENV,
  PORT_ENV,
  WORKSPACE_ENV,
  flag,
  setting,
  workflowRoots,
  type Environment,
} from "./config.ts";
import {
  HOSTS_FILE_ENV,
  RemoteHostUnavailableError,
  loadHostRegistry,
  mutateHostRegistry,
  resolveHostRef,
  type HostMutation,
  type HostRegistry,
  type ResolvedHost,
} from "./hosts.ts";
import { recordJobHost, resolveJobTarget, type JobTarget } from "./jobLedger.ts";
import {
  InertSlotError,
  toolAnswer,
  ToolArgumentError,
  WorkflowNotFoundError,
} from "./toolResult.ts";
import { describeSlots } from "./workflows/describe.ts";
import {
  discoverWorkflows,
  inertInputsOfFile,
  inertInputsOfText,
  type InertInput,
} from "./workflows/discover.ts";
import { listSlots } from "./workflows/slots.ts";
import { runWorkflow, type EffectiveParameter, type WorkflowRun } from "./workflows/run.ts";
import { applySlots, type SlotInputs } from "./workflows/setSlots.ts";

/**
 * The tools themselves: what a model sees, and what it gets back.
 *
 * Two rules shape everything here.
 *
 * **The descriptions are the plan.** A model has no other source of the fact
 * that `run_workflow`'s inputs are keyed by an address it must obtain from
 * `describe_workflow` first, or that a submit returns a handle and no outputs.
 * The descriptions are written for that reader, not as labels.
 *
 * **Nothing throws.** Every handler is wrapped in `toolAnswer`, which turns a
 * thrown error into a classified, structured tool result — see
 * `toolResult.ts` for why an uncaught throw is a materially worse answer.
 *
 * ## The wire format is snake_case
 *
 * The library types are camelCase because they are TypeScript; the CLI, the slot
 * addresses and the tool parameters are all snake_case. Mapping explicitly at
 * this boundary costs a few lines and buys one convention on the wire — and it
 * is also the only place that decides what a model does *not* see, which is how
 * a run's 200 progress events stay out of its context.
 */

/**
 * Budget for a submit. The CLI validates the graph and POSTs it; the library's
 * own 120s default is already generous for that.
 */
const SUBMIT_TIMEOUT_MS = 120_000;

/**
 * Budget for `wait: true`. Long enough for an ordinary image render, short
 * enough that a stuck call comes back with an actionable answer rather than
 * never returning — and a run that outlasts it is not lost, because
 * `workflows/run.ts` names the `prompt_id` on the timeout.
 */
const WAIT_TIMEOUT_MS = 300_000;

/** The widest budget a caller may ask for: half an hour, for a video workflow. */
const MAX_TIMEOUT_SECONDS = 1_800;

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** What the tools need to know about this installation. */
export interface ToolConfig {
  /**
   * The **default host's** address. `undefined` means the library default,
   * `127.0.0.1`.
   *
   * No longer the address every tool talks to: since multi-host, each call
   * resolves its own target against the registry — see {@link resolveTarget}.
   * These two survive because they are still the whole configuration of an
   * installation that has no registry file, which is every installation that
   * predates one, and because a registry that lists hosts of its own reports
   * them as ignored rather than silently losing to them.
   */
  host: string | undefined;
  /** `undefined` means the library default, `8188`. */
  port: number | undefined;
  /** Where the `/object_info` cache lives. `undefined` means `~/.cache/mcp-comfyui`. */
  cacheDir: string | undefined;
  /** The ComfyUI directory to launch from. `undefined` lets comfy resolve one. */
  workspace: string | undefined;
  /**
   * May this server start ComfyUI when a tool needs one and nothing answers?
   * Defaults to **true**.
   */
  autoLaunch: boolean;
  /** Whether `launch_comfyui` is registered at all. Defaults to false. */
  allowLaunch: boolean;
  /** The environment the workflow roots are read from, per call. */
  env: Environment;
}

/**
 * Read the operator's configuration, failing on anything unusable.
 *
 * A bad port is refused **here**, at construction, rather than at the first tool
 * call. The alternative is a server that starts, registers, connects, and then
 * fails every call with a message about an address — which is a much longer
 * road to the same one-character fix.
 */
export function toolConfig(env: Environment = process.env): ToolConfig {
  const rawPort = setting(env, PORT_ENV);
  let port: number | undefined;
  if (rawPort !== undefined) {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
      throw new Error(
        `${PORT_ENV}=${JSON.stringify(rawPort)} is not a TCP port (expected ${MIN_PORT}-${MAX_PORT}).`,
      );
    }
  }

  return {
    host: setting(env, HOST_ENV),
    port,
    cacheDir: setting(env, CACHE_DIR_ENV),
    workspace: setting(env, WORKSPACE_ENV),
    // The two launch settings answer two different questions, which is why
    // there are two of them and why neither gates the other:
    //
    //   AUTO_LAUNCH  — may THIS SERVER start ComfyUI when a tool needs one?
    //   ALLOW_LAUNCH — may a MODEL start one, with startup flags of its own?
    //
    // The second is strictly the more powerful: `launch_comfyui` takes --cpu,
    // --listen and a free-form argument list, so it stays opt-in even now that
    // the first defaults to on. Keeping them independent is also what lets an
    // operator say "never behind my back, but do give me a tool my client will
    // prompt me to approve" — which is what ALLOW_LAUNCH alone used to mean, so
    // nobody who set it sees their configuration change meaning.
    autoLaunch: flag(env, AUTO_LAUNCH_ENV, true),
    allowLaunch: flag(env, ALLOW_LAUNCH_ENV, false),
    env,
  };
}

// --- which host ----------------------------------------------------------

/**
 * The registry, read fresh for this call.
 *
 * Per call, not once at startup, and the cost is a few hundred bytes off the
 * page cache against a tool call that is already reading whole workflow files.
 * What it buys: an operator who edits `hosts.json`, or a `manage_hosts` call
 * that rewrites it, takes effect on the very next tool call rather than on the
 * next restart of their MCP client — and `manage_hosts` needs no shared mutable
 * state to invalidate, because there is none.
 */
function hostRegistry(config: ToolConfig): Promise<HostRegistry> {
  return loadHostRegistry({
    env: config.env,
    defaultAddress: { host: config.host, port: config.port },
  });
}

/** The host one call meant — its `host` argument, or the registry's default. */
async function resolveTarget(config: ToolConfig, host: string | undefined): Promise<ResolvedHost> {
  return resolveHostRef(await hostRegistry(config), host);
}

/** The address arguments every CLI-backed call passes through. */
function address(resolved: ResolvedHost): { host: string; port: number } {
  return { host: resolved.host, port: resolved.port };
}

/** How every host-aware tool reports which instance it actually talked to. */
function targetBody(resolved: ResolvedHost): Record<string, unknown> {
  return {
    name: resolved.name,
    address: `${resolved.host}:${resolved.port}`,
    local: resolved.local,
    auto_launch: resolved.autoLaunch,
  };
}

/**
 * Which host a question about an existing job goes to — the caller's, this
 * server's memory of the run, or the only host there is. See
 * `jobLedger.ts`'s `resolveJobTarget` for why a fourth option ("the default")
 * is deliberately not on that list.
 */
async function decideJobTarget(
  config: ToolConfig,
  promptId: string,
  host: string | undefined,
): Promise<JobTarget> {
  const registry = await hostRegistry(config);
  const explicit = host === undefined ? null : resolveHostRef(registry, host);
  return resolveJobTarget(registry, promptId, explicit);
}

/**
 * The host a job tool used, and how it was chosen.
 *
 * `host_source` is reported rather than left implicit because the three
 * answers are not interchangeable to a caller reading a `prompt_not_found`:
 * `explicit` means their own argument was used, `ledger` means this server
 * knew, and `only` means there was exactly one host it could have been.
 */
function jobTargetBody(decided: JobTarget): Record<string, unknown> {
  return {
    target: targetBody(decided.target),
    host_source: decided.source,
    ...(decided.contradiction === null
      ? {}
      : {
          warnings: [
            {
              source: "host",
              code: "host_contradicts_ledger",
              message:
                `this server recorded ${decided.contradiction.name ?? "an address"} ` +
                `(${decided.contradiction.host}:${decided.contradiction.port}) for this job, but ` +
                `\`host\` named ${decided.target.label}; the argument was used. If the answer is ` +
                `\`prompt_not_found\`, try it without \`host\`.`,
            },
          ],
        }),
  };
}

/**
 * A running ComfyUI, started if need be, if permitted, **and if it is even
 * possible**.
 *
 * Only the two tools that genuinely cannot work without a server call this.
 * `comfy_status` never does — it is the tool you call to *ask* whether anything
 * is running, and a status query that starts a GPU process is indefensible.
 * `get_job` and `cancel_job` never do either: a freshly started ComfyUI has no
 * record of the job being asked about, so launching one would burn a minute to
 * answer the same question worse.
 *
 * The remote arm is not a policy choice, it is arithmetic: `comfy launch` takes
 * no `--host`, so no launch performed here could ever produce a server at
 * another machine's address. Probing and then refusing is the whole of what can
 * be done, and it is done in that order so that a remote instance which *is* up
 * behaves exactly like a local one. Handing this to `ensureInstance` with
 * `autoLaunch: false` would reach the same refusal by a worse road: the message
 * would offer `MCP_COMFYUI_AUTO_LAUNCH=1` as the fix, and setting it would
 * change nothing at all.
 */
async function ensureRunning(config: ToolConfig, resolved: ResolvedHost) {
  if (!resolved.local) {
    const detection = await detectInstance(address(resolved));
    if (detection.running) return { outcome: "already_running" as const, instance: detection };
    throw new RemoteHostUnavailableError(resolved, detection.url, detection.reason);
  }
  return ensureInstance({
    ...address(resolved),
    workspace: config.workspace,
    // Both must agree: the installation-wide setting says whether this server
    // may ever start ComfyUI, and the host's own entry says whether it may for
    // this box. A remote host's entry is always false — `hosts.ts` forces it —
    // so this is belt and braces behind the branch above.
    autoLaunch: config.autoLaunch && resolved.autoLaunch,
  });
}

// --- workflow handles ----------------------------------------------------

interface ResolvedWorkflow {
  /** The handle `list_workflows` reports, or the file's stem for a raw path. */
  name: string;
  /** A file on this machine, or — for a remote — its path in that instance's own library. */
  path: string;
  source: "local" | "remote";
  /**
   * A remote workflow's exact bytes, fetched once and handed to `applySlots`
   * verbatim. Absent for a local workflow, which is byte-copied from disk
   * instead. Never parsed, in either case (landmine #1).
   */
  contents?: Uint8Array;
}

/**
 * Turn the handle a caller passed into a file.
 *
 * **A name and a path are both accepted**, and that is a deliberate choice
 * rather than leniency. `list_workflows` reports `name` first and it is the
 * short, memorable thing a model will use; requiring the absolute path would
 * make every describe a two-step dance and would invite a model to assemble a
 * path out of a directory it half-remembers. Meanwhile an operator pointing at a
 * file they have not added to the configured roots is asking a perfectly clear
 * question, and refusing it would be this server inventing a restriction.
 *
 * The order matters: name first. A path is unambiguous, but a *name* that
 * happens to look like one is not, and the handle this server published is the
 * one it must honour.
 *
 * A relative path is not accepted as a path. It would be resolved against
 * whatever directory the MCP client spawned this process in, which is nothing
 * the caller chose and nothing they can see, so it falls through and is reported
 * as an unknown name — with the names that would have worked.
 */
async function resolveWorkflow(
  handle: string,
  config: ToolConfig,
  target: ResolvedHost,
  hostWasNamed: boolean,
): Promise<ResolvedWorkflow> {
  const { workflows } = await discoverWorkflows({ env: config.env });

  const named = workflows.find((workflow) => workflow.name === handle);
  if (named !== undefined) return { name: named.name, path: named.path, source: "local" };

  const located = workflows.find((workflow) => workflow.path === handle);
  if (located !== undefined) return { name: located.name, path: located.path, source: "local" };

  // Only now, and only for a handle no local file answers to. Running a file
  // from the local library **on** another host is the ordinary case — that is
  // what `host` is for — so the local library is searched first, and this
  // costs a round trip only for a name it did not have.
  if (!isAbsolute(handle)) {
    const remote = await resolveRemoteWorkflow(handle, target, hostWasNamed);
    if (remote !== null) return remote;
  }

  if (isAbsolute(handle)) return { name: basename(handle, ".json"), path: handle, source: "local" };

  throw new WorkflowNotFoundError(
    handle,
    workflows.map((workflow) => workflow.name),
  );
}

/**
 * The same handle against the target host's own saved workflows.
 *
 * Three spellings are accepted, for the same reason `resolveWorkflow` accepts
 * both a name and a path: the qualified handle `list_workflows` publishes
 * (`rtx-video/portrait`), the bare stem, and the relative path the instance
 * itself reports (`workflows/portrait.json`). The qualified form is the one to
 * prefer and the only one that cannot collide.
 *
 * Returns `null` rather than throwing when the host has no such workflow, so
 * the caller reports one `workflow_not_found` naming the local library rather
 * than two different errors for the same mistake.
 *
 * **A host that could not be asked depends on who asked.** If the caller named
 * a `host`, its being unreachable is the answer to their question and is
 * reported. If they named none, this host is only being consulted as a
 * fallback for a handle the local library did not have — found live, against a
 * stopped local ComfyUI: `run_workflow {workflow: "typo"}` came back as a
 * `fetch failed` about `/api/userdata`, which is a true statement about
 * something the caller never asked about, in place of the `workflow_not_found`
 * naming the 27 workflows that would have worked.
 */
async function resolveRemoteWorkflow(
  handle: string,
  target: ResolvedHost,
  hostWasNamed: boolean,
): Promise<ResolvedWorkflow | null> {
  let workflows: Awaited<ReturnType<typeof listRemoteWorkflows>>;
  try {
    workflows = await listRemoteWorkflows(address(target));
  } catch (err) {
    if (hostWasNamed) throw err;
    return null;
  }
  if (workflows.length === 0) return null;

  const prefix = `${target.label}/`;
  const wanted = handle.startsWith(prefix) ? handle.slice(prefix.length) : handle;
  const found =
    workflows.find((workflow) => workflow.path === wanted) ??
    workflows.find((workflow) => workflow.stem === wanted);
  if (found === undefined) return null;

  return {
    name: `${target.label}/${found.stem}`,
    path: found.path,
    source: "remote",
    contents: await fetchRemoteWorkflow(found.path, address(target)),
  };
}

/**
 * A workflow as a file `comfy` can be pointed at, whether it came from this
 * machine or from the host's own library.
 *
 * `applySlots` with no inputs is exactly this primitive already: it makes the
 * private copy and spawns nothing (`set-slot` requires at least one
 * `ADDR=VALUE`, so calling it with none would be a Typer usage error). Reusing
 * it here rather than writing a second temp-file dance is what keeps one
 * answer to "where do prepared copies live and who deletes them".
 *
 * **The caller owns the result's `dispose`.**
 */
function stageWorkflow(resolved: ResolvedWorkflow) {
  return applySlots(resolved.path, {}, { contents: resolved.contents });
}

/**
 * One host's own saved workflows, in `list_workflows`'s shape.
 *
 * A host that cannot be reached degrades to a `problem` rather than failing the
 * call, which is `workflows/discover.ts`'s promise applied one layer out: a
 * listing is all-or-nothing to its caller, and denying somebody their 27 local
 * workflows because a remote box is asleep is the wrong trade. An **unknown
 * host name** is a different thing and does throw — that is the caller's own
 * argument being wrong, and silently listing nothing for it would look like a
 * host with no workflows.
 */
async function remoteWorkflows(
  config: ToolConfig,
  host: string,
): Promise<{
  target: ResolvedHost;
  workflows: Record<string, unknown>[];
  problem?: { host: string; reason: string };
}> {
  const target = await resolveTarget(config, host);
  try {
    const found = await listRemoteWorkflows(address(target));
    return {
      target,
      workflows: found.map((workflow) => ({
        name: `${target.label}/${workflow.stem}`,
        path: workflow.path,
        source: `remote:${target.label}`,
        // Deciding this means downloading the file, and a listing of 27 would
        // mean 27 downloads to answer a question describe_workflow answers for
        // the one workflow anybody actually wants.
        format: "unknown",
        node_count: null,
        has_subgraphs: null,
        size_bytes: workflow.sizeBytes,
        modified: workflow.modified,
      })),
    };
  } catch (err) {
    return {
      target,
      workflows: [],
      problem: { host: target.label, reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Refuse `run_workflow` before anything is spawned, when one or more
 * requested addresses are decoys — see `workflows/discover.ts`'s
 * `inertInputsOf` for the rule. Reads the workflow file directly, independent
 * of `comfy`, so the refusal costs nothing beyond the file this server was
 * about to touch anyway.
 *
 * Every offending address is named at once rather than stopping at the
 * first: a caller fixing one at a time against a workflow with several would
 * otherwise spend one round trip per address.
 */
async function refuseInertInputs(resolved: ResolvedWorkflow, inputs: SlotInputs | undefined): Promise<void> {
  const addresses = Object.keys(inputs ?? {});
  if (addresses.length === 0) return;

  // A remote workflow is analysed from the bytes already in hand rather than
  // from a file, which keeps this refusal where it belongs: before anything is
  // spawned and before any temp directory exists.
  const inertInputs =
    resolved.contents === undefined
      ? await inertInputsOfFile(resolved.path)
      : inertInputsOfText(new TextDecoder().decode(resolved.contents));
  if (inertInputs.size === 0) return;

  const offending: InertInput[] = [];
  for (const address of addresses) {
    const found = inertInputs.get(address);
    if (found !== undefined) offending.push(found);
  }
  if (offending.length > 0) {
    throw new InertSlotError(
      resolved.name,
      offending.map((entry) => ({ address: entry.address, upstream: entry.upstream })),
    );
  }
}

// --- wire shapes ---------------------------------------------------------

function instanceBody(instance: RunningInstance): Record<string, unknown> {
  return {
    running: true,
    url: instance.url,
    host: instance.host,
    port: instance.port,
    version: instance.version,
    deploy_environment: instance.deployEnvironment,
    desktop_managed: instance.desktopManaged,
    output_directory: instance.outputDirectory,
    input_directory: instance.inputDirectory,
    devices: instance.devices.map((device) => ({
      name: device.name,
      type: device.type,
      vram_total: device.vramTotal,
      vram_free: device.vramFree,
    })),
    argv: instance.argv,
  };
}

/**
 * A run's artifacts, in the three ways a caller can reach them.
 *
 * ```json
 * "outputs": {
 *   "files": ["/Users/me/ComfyUI-Shared/output/a.png"],
 *   "urls":  ["http://127.0.0.1:8188/view?filename=b.png&subfolder=&type=output"],
 *   "local_paths": {
 *     "http://127.0.0.1:8188/view?filename=b.png&subfolder=&type=output":
 *       "/Users/me/ComfyUI-Shared/output/b.png"
 *   }
 * }
 * ```
 *
 * **What to read.** Every artifact appears exactly once in `files` or in
 * `urls`. `files` are already local. For a URL, look it up in `local_paths`:
 * the value is an absolute path to a file that existed when this answer was
 * built, and **no key means there is no local path** — the URL has to be
 * fetched. There is no third state to infer.
 *
 * **Why a map beside the two lists rather than a merged one.** The resolved
 * path is a *second name* for an artifact already listed in `urls`, not another
 * artifact. Appending it to `files` would make the same image appear twice, so
 * a caller counting artifacts would over-count and a caller asking "is there a
 * local path for *this* URL" would be left matching basenames — guessing.
 * Replacing the URL would be worse: this server may answer a client on another
 * machine, for which the path is useless and the URL was the only way in.
 * Keeping `files`/`urls` exactly as they were also keeps one vocabulary between
 * this wire shape and `ClassifiedOutputs`, which `workflows/run.ts` and
 * `comfy/jobs.ts` both return and which no caller should have to translate.
 *
 * `local_paths` is always present, empty when nothing resolved: an absent key
 * would be indistinguishable from a server too old to have looked.
 */
function outputsBody(
  outputs: ClassifiedOutputs,
  instance: ArtifactLocation | null,
  fetched: FetchedArtifact[] | null = null,
): Record<string, unknown> {
  return {
    files: outputs.files,
    urls: outputs.urls,
    local_paths: instance === null ? {} : resolveArtifactPaths(outputs.urls, instance),
    // Absent unless it was asked for, so an empty `fetched` always means "asked
    // for, and none came across" rather than "never attempted".
    ...(fetched === null
      ? {}
      : {
          fetched: Object.fromEntries(
            fetched.filter((one) => one.path !== null).map((one) => [one.url, one.path]),
          ),
          fetch_problems: fetched
            .filter((one) => one.problem !== null)
            .map((one) => ({ url: one.url, problem: one.problem })),
        }),
  };
}

/**
 * Copy a run's artifacts here, when the caller asked and there is anything to
 * copy.
 *
 * Per `prompt_id`, under this server's own cache directory, so two runs cannot
 * overwrite each other's files even when ComfyUI reuses a filename — which it
 * does, because its counter restarts per output-node prefix.
 */
async function fetchIfAsked(
  urls: readonly string[],
  promptId: string | null,
  config: ToolConfig,
  wanted: boolean,
): Promise<FetchedArtifact[] | null> {
  if (!wanted) return null;
  if (urls.length === 0 || promptId === null) return [];
  return await fetchArtifacts(urls, {
    destination: join(cacheRoot(config.cacheDir), "fetched", promptId),
  });
}

/** The parameter both artifact-returning tools take, worded once. */
const fetchOutputsArgument = z
  .boolean()
  .default(false)
  .describe(
    "Download the run's artifacts to this machine and report where they landed, under " +
      "`outputs.fetched`. Off by default, and deliberately: a run on this machine already has " +
      "its files here (`outputs.local_paths`), and a video workflow's outputs can be hundreds of " +
      "megabytes to copy across a network. Turn it on for a run on another host whose images you " +
      "actually want to open.",
  );

/**
 * The instance whose directories can turn a job's `/view` URLs into paths, or
 * `null` if there is none to ask.
 *
 * A **probe**, never a launch, and only when there is something to resolve.
 * `get_job` must not start a ComfyUI — see {@link ensureRunning} — and a freshly
 * started one would be the wrong instance anyway: it neither knows the job nor
 * wrote the file. An unreachable server therefore costs the caller nothing but
 * the paths it could not have had.
 *
 * Skipped outright for a host on another machine. Its `outputDirectory` is a
 * path in that machine's filesystem, so there is nothing here for it to name —
 * `comfy/outputs.ts` refuses it a second time for the same reason, and this
 * saves a probe that could only ever have been discarded.
 */
async function resolvingInstance(
  urls: readonly string[],
  resolved: ResolvedHost,
): Promise<ArtifactLocation | null> {
  if (urls.length === 0 || !resolved.local) return null;
  const detection = await detectInstance(address(resolved));
  return detection.running ? detection : null;
}

function jobBody(
  job: JobStatus,
  instance: ArtifactLocation | null,
  fetched: FetchedArtifact[] | null,
): Record<string, unknown> {
  return {
    prompt_id: job.promptId,
    status: job.status,
    terminal: job.terminal,
    queue_position: job.queuePosition,
    workflow_size: job.workflowSize,
    outputs: outputsBody(job.outputs, instance, fetched),
    error: job.error,
    host: job.host,
    port: job.port,
  };
}

function cancelBody(result: CancelResult): Record<string, unknown> {
  const common = { outcome: result.outcome, prompt_id: result.promptId };
  return result.outcome === "not_found"
    ? { ...common, error: result.error }
    : { ...common, previous_status: result.previousStatus };
}

/**
 * A loud warning for every requested address the submitted graph did not
 * confirm — `missing` or `mismatch` only. `unconfirmed` is deliberately
 * silent: it means "the submitted graph's own report of itself never
 * arrived", which is not evidence of anything having gone wrong, only that
 * this particular check could not be made.
 *
 * This is precisely the check that would have caught the benchmark bug: a
 * caller reading only `applied` — `set-slot`'s own echo of what it was
 * ASKED, never proof of what took — cannot tell a real success from
 * `set-slot` reporting an address `applied` that the submitted graph never
 * carried at all. A `warnings` entry is placed where every other warning
 * already lands, rather than trusting a caller to go read a new field on
 * their own.
 */
function effectiveParameterWarnings(parameters: EffectiveParameter[]): Array<Record<string, unknown>> {
  return parameters
    .filter((parameter) => parameter.status === "missing" || parameter.status === "mismatch")
    .map((parameter) =>
      parameter.status === "missing"
        ? {
            code: "value_not_submitted",
            message:
              `${parameter.address} was requested but does not appear in the submitted graph at all; ` +
              `the value was not applied to this run.`,
            address: parameter.address,
          }
        : {
            code: "value_mismatch",
            message:
              `${parameter.address} was requested as ${JSON.stringify(parameter.requested)} but the ` +
              `submitted graph carries ${JSON.stringify(parameter.submitted)} instead.`,
            address: parameter.address,
          },
    );
}

/**
 * A run's answer.
 *
 * `events` is deliberately absent. A completed run's events are the sampler
 * counting to twenty, they are capped at 200 by the library, and every one of
 * them would land in a model's context in place of the thing it asked for. The
 * count and the truncation flag stay, so the omission is visible; a *failed*
 * run is the opposite case and its events travel on the error, because that is
 * where the traceback is.
 *
 * `applied` (from `set-slot`) and `effective_parameters` (from the submitted
 * graph's own `prompt_preview` report of itself) are BOTH kept, deliberately:
 * `applied` is what was asked, `effective_parameters` is what took, and the
 * difference between them is the whole reason the second one exists — see
 * `workflows/run.ts`'s `extractEffectiveParameters`.
 *
 * The three warning sources are merged into one list rather than nested,
 * because a caller wants to know whether anything is wrong, not which of
 * three checks said so — but each entry keeps a `source`, since the fix for
 * "the value you set is out of range", "only one output node returned
 * anything" and "the value you set was silently discarded" are not remotely
 * the same.
 */
function runBody(
  workflow: ResolvedWorkflow,
  applied: string[],
  setSlotWarnings: Array<Record<string, unknown>>,
  run: WorkflowRun,
  instance: ArtifactLocation,
  fetched: FetchedArtifact[] | null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workflow: { name: workflow.name, path: workflow.path, source: workflow.source },
    status: run.status,
    terminal: run.terminal,
    prompt_id: run.promptId,
    applied,
    effective_parameters: run.effectiveParameters,
    outputs: outputsBody(run.outputs, instance, fetched),
    warnings: [
      ...setSlotWarnings.map((warning) => ({ source: "set_slot", ...warning })),
      ...run.warnings.map((warning) => ({ source: "run", ...warning })),
      ...effectiveParameterWarnings(run.effectiveParameters).map((warning) => ({
        source: "effective_parameters",
        ...warning,
      })),
    ],
    elapsed_seconds: run.elapsedSeconds,
    event_count: run.events.length,
    events_truncated: run.eventsTruncated,
    unrecognised_lines: run.unrecognisedLines,
  };

  if (!run.terminal && run.promptId !== null) {
    body["next_step"] =
      `The run was submitted and is not finished. Call get_job with prompt_id ` +
      `"${run.promptId}" until \`terminal\` is true; its \`outputs\` are the files this run produced.`;
  }
  return body;
}

/**
 * The node definitions, starting ComfyUI only if there is no other way to get
 * them.
 *
 * The cache is tried first and is usually enough — that is the entire point of
 * landmine #7, and it is why describing a workflow normally touches nothing.
 * Only when the cache is missing or stale *and* the fetch that would refresh it
 * fails is a launch worth considering, and even then only if nothing is already
 * answering: a fetch that failed against a **running** instance failed for some
 * other reason, and re-fetching after confirming it is up would just produce the
 * same error a second time.
 */
async function withObjectInfo(
  location: { host?: string; port?: number; cacheDir?: string },
  config: ToolConfig,
  resolved: ResolvedHost,
) {
  try {
    return await getObjectInfo(location);
  } catch (err) {
    // A remote host is skipped here rather than probed: `ensureRunning` would
    // refuse it, and that refusal would replace the fetch error — which is the
    // one that says what actually went wrong — with one about launching.
    if (!(err instanceof ObjectInfoFetchError) || !config.autoLaunch || !resolved.local) throw err;
    const ensured = await ensureRunning(config, resolved);
    // It was up all along, so the address is not the problem; the original
    // diagnosis is the better one and a retry would only obscure it.
    if (ensured.outcome === "already_running") throw err;
    return await getObjectInfo({ ...location, refresh: true });
  }
}

/**
 * Whether a string value is one comfy-cli's own `_parse_value` could
 * reinterpret as something other than a string (finding 1). `_parse_value`
 * is `json.loads(raw)` with a fallback to the raw text on failure
 * (`comfy_cli/command/workflow.py:145-150`), so exactly the values that
 * `JSON.parse` here also accepts are the ones at risk: `"true"`, `"42"`,
 * `"null"`, a JSON array or object spelled as text. Ordinary prose like `"a
 * photo of a cat"` is not valid JSON on its own, so `JSON.parse` throws and
 * this reports it as unambiguous — matching the CLI's own fallback exactly.
 *
 * This is a **gate**, not the fix itself: it decides whether it is worth
 * asking the CLI what type the target slot actually is (see
 * {@link resolveSlotTypes}) before spending that round trip. An ordinary
 * caller passing ordinary values never pays for it.
 */
function looksLikeJsonLiteral(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The type of every slot named in `inputs`, keyed by address — what
 * `applySlots` needs to decide, per finding 1, whether a string value has to
 * be JSON-quoted before it reaches `set-slot`. See
 * `workflows/setSlots.ts`'s `ApplySlotsOptions.slotTypes` for what this
 * changes and why it is safe to leave unresolved.
 *
 * Two things keep this cheap on the ordinary path, where it changes nothing
 * observable about a call that was already correct:
 *
 * - **Skipped unless some value could actually be misread.** Fetching a
 *   listing costs a live round trip nobody asked for when nothing in
 *   `inputs` is ambiguous — see {@link looksLikeJsonLiteral} — which is the
 *   overwhelmingly common case (a prompt's prose, a plain number, a native
 *   boolean).
 * - **Best-effort.** If the listing cannot be fetched or read, this falls
 *   back to `{}` rather than failing the run: `applySlots` treats an address
 *   missing from the map exactly as it always treated every address before
 *   finding 1 was fixed, which is not a new failure mode, only a missed
 *   improvement for this one call. The `set-slot` call right after this is
 *   talking to the same server over the same file, so a listing failure here
 *   is rarely survivable there either — the caller finds out regardless, from
 *   the call that was always going to tell them.
 *
 * Exported for `tests/tools.test.ts`, which is the only place this module has
 * unit tests below the level of a full tool call.
 */
export async function resolveSlotTypes(
  workflowPath: string,
  inputs: SlotInputs | undefined,
  // The resolved address rather than the whole `ToolConfig`: this is the only
  // thing it ever wanted from one, and taking it directly is what keeps the
  // function callable from a test without standing up a host registry.
  location: { host: string; port: number },
): Promise<Record<string, string>> {
  const values = Object.values(inputs ?? {});
  const ambiguous = values.some((value) => typeof value === "string" && looksLikeJsonLiteral(value));
  if (!ambiguous) return {};

  try {
    const listing = await listSlots(workflowPath, location);
    const types: Record<string, string> = {};
    for (const slot of listing.slots) types[slot.address] = slot.type;
    return types;
  } catch {
    return {};
  }
}

// --- input schemas -------------------------------------------------------

const workflowArgument = z
  .string()
  .min(1)
  .describe(
    "A workflow's `name` from list_workflows (e.g. \"default_image_gen\"), or the absolute " +
      "path to a workflow file. Names are case-sensitive and carry no .json extension.",
  );

const promptIdArgument = z
  .string()
  .min(1)
  // Finding 2. A prompt_id travels to `comfy jobs status`/`jobs cancel` as a
  // bare positional, ahead of this server's own --host/--port; a value
  // starting with `-` is read by the CLI's argument parser as another flag
  // instead — verified live, it can override --host/--port outright (see
  // `comfy/jobs.ts`'s `InvalidPromptIdError`, which is the guarantee this
  // repeats here only to turn it into a clean schema error instead of a
  // thrown one). A real prompt_id is a UUID and never starts with `-`.
  .refine((id) => !id.startsWith("-"), {
    message: "a prompt_id cannot start with `-`; it is a UUID returned by run_workflow or jobs ls",
  })
  .describe("The `prompt_id` a run_workflow call returned.");

/**
 * The slot overrides.
 *
 * The value union is `string | number | boolean` and the string arm is not a
 * convenience — it is the documented, exact way to set an integer above 2^53.
 * A JSON number loses whole digits past that point, and a ComfyUI seed goes to
 * 2^64−1, so a seed sent as a number is silently a *different* seed by the time
 * anything can notice (landmines #11/#12). An `ADDR=VALUE` pair travels to the
 * CLI as command-line text and is read by Python, whose integers are arbitrary
 * precision, so the string form is written exactly.
 *
 * The keys are **not** enumerated. They are per-workflow and come from
 * `describe_workflow`; an enum here would be a claim about a workflow this
 * schema has never seen.
 */
const inputsArgument = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  // Finding 2. Each key becomes one ADDR=VALUE positional to `set-slot`;
  // `workflows/setSlots.ts`'s `encodePair` refuses one starting with `-` for
  // the same reason `promptIdArgument` above does — verified live, an
  // address of "--input" smuggled in a caller-chosen --input file. Repeated
  // here so a model gets a schema-validation error before anything is
  // spawned, rather than the tool's own thrown one; `encodePair` remains the
  // guarantee, since a direct caller of `applySlots` never goes through this
  // schema at all.
  .refine((record) => Object.keys(record).every((address) => !address.startsWith("-")), {
    message: "a slot address cannot start with `-`; a real address is `<instance_id>.<name>`, e.g. \"3.seed\"",
  })
  .describe(
    "Values to set, keyed by slot address — e.g. {\"3.seed\": 42, \"6.text\": \"a photo of a cat\"}. " +
      "Get the addresses and their constraints from describe_workflow; an address that workflow " +
      "does not have is rejected rather than ignored. An integer larger than 9007199254740991 " +
      "(2^53-1) MUST be passed as a string of digits, e.g. \"18446744073709551615\" — JSON numbers " +
      "lose whole digits above that, so a seed sent as a number would silently become a different " +
      "seed. Omit an address to keep the value the workflow file already holds.",
  );

/**
 * Which ComfyUI a call is for.
 *
 * Optional on every tool, and omitting it is the default host — which is what
 * makes every call written before this argument existed keep working
 * unchanged.
 */
const hostArgument = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Which ComfyUI to use: a `name` from list_hosts (e.g. \"rtx-video\"), or an address such as " +
      "\"100.86.199.90:8189\". Omit it to use the default host. A name wins over an address " +
      "spelled the same way. An address must carry an explicit port unless it is an IP literal " +
      "or localhost — a bare word with no port is reported as an unknown host name, with the " +
      "names that would have worked, rather than looked up as a hostname and reported " +
      "unreachable.",
  );

// --- registration --------------------------------------------------------

/**
 * Register every tool this installation offers.
 *
 * `launch_comfyui` is registered **only** when the operator has opted in.
 * Omitting it entirely rather than registering a tool that refuses is the point:
 * a model plans from the tool list, and a tool that is not there cannot be
 * chosen. Starting a GPU process is not a decision to leave to inference.
 */
export function registerTools(server: McpServer, config: ToolConfig): void {
  server.registerTool(
    "comfy_status",
    {
      title: "ComfyUI status",
      description:
        "Report whether a ComfyUI server is reachable, and what it is: version, accelerator " +
        "devices with their VRAM, and the output and input directories it was started with. " +
        "Nothing running is a normal answer rather than a failure — `running: false` comes back " +
        "with the address that was probed and the reason it did not answer. Call this first " +
        "whenever another tool reports the server unreachable. Pass `host` to ask about a " +
        "particular ComfyUI; list_hosts names them. This never starts anything, on any host.",
      inputSchema: { host: hostArgument },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ host }) =>
      toolAnswer(async () => {
        const resolved = await resolveTarget(config, host);
        const detection = await detectInstance(address(resolved));
        return {
          target: targetBody(resolved),
          ...(detection.running
            ? instanceBody(detection)
            : {
                running: false,
                url: detection.url,
                host: detection.host,
                port: detection.port,
                reason: detection.reason,
              }),
        };
      }),
  );

  server.registerTool(
    "list_hosts",
    {
      title: "List ComfyUI hosts",
      description:
        "List the ComfyUI instances this server can be pointed at. Every other tool takes an " +
        "optional `host` naming one of these; omitting it uses `default`. Each entry says whether " +
        "the instance is on this machine (`local`) and whether this server may start it " +
        "(`auto_launch`) — only a local one can be started, because `comfy launch` runs ComfyUI " +
        "wherever `comfy` runs and has no way to reach another machine. This reads a JSON file " +
        "and never contacts any of the hosts, so an entry appearing here says nothing about " +
        "whether that ComfyUI is up; call comfy_status for that. `problem` and `warnings` come " +
        "first when the registry file has something wrong with it — a host missing from this list " +
        "usually has its explanation there. Use manage_hosts to change the file.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      toolAnswer(async () => {
        const registry = await hostRegistry(config);
        return {
          // Lead with the breakage. A registry that half-loaded is the case
          // where a caller most needs to know it, and burying it under a
          // plausible-looking host list is how a routing mistake goes unnoticed.
          problem: registry.problem,
          warnings: registry.warnings,
          registry: {
            path: registry.path,
            present: registry.present,
            repairable: registry.repairable,
            env_var: HOSTS_FILE_ENV,
          },
          default: registry.defaultName,
          count: registry.hosts.length,
          hosts: registry.hosts.map((entry) => ({
            name: entry.name,
            host: entry.host,
            port: entry.port,
            address: `${entry.host}:${entry.port}`,
            local: entry.local,
            auto_launch: entry.autoLaunch,
            note: entry.note,
            is_default: entry.name === registry.defaultName,
          })),
        };
      }),
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description:
        "List the ComfyUI workflow files this server can see. Start here: describe_workflow and " +
        "run_workflow both take a workflow by the `name` in this listing, or by its absolute " +
        "`path`. Only entries with `format: \"frontend\"` — the graph the ComfyUI editor saves — " +
        "can be described or run; `api` is the Export (API) form, which these tools do not read, " +
        "and `invalid` carries a `problem` saying what is wrong with the file. `has_subgraphs` is " +
        "informational only — it does not block describing or running a workflow — and means its " +
        "settable addresses may run deeper than the usual `<id>.<name>`, e.g. `52/6.text`; " +
        "describe_workflow's `inert` list is what actually says which addresses on it are decoys. " +
        "Set MCP_COMFYUI_WORKFLOW_DIRS (colon-separated, like PATH) to change the directories scanned. " +
        "Pass `host` to ALSO list that ComfyUI's own saved workflows, over its HTTP API. Those " +
        "entries are tagged `source: \"remote:<host>\"`, their `name` is qualified with the host " +
        "(`rtx-video/portrait`), and their `format` is `\"unknown\"` because deciding it means " +
        "downloading the file — describe_workflow will say if one is not a frontend graph. Every " +
        "local entry is tagged `source: \"local\"` and can be run on any host; the local library " +
        "and each host's own files are two separate places, and both are usable.",
      inputSchema: { host: hostArgument },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ host }) =>
      toolAnswer(async () => {
        const listing = await discoverWorkflows({ env: config.env });
        const local = listing.workflows.map((workflow) => ({ ...workflow, source: "local" }));

        // Only when a host was named. Without one this lists exactly what it
        // always listed — and the default host is usually this machine, whose
        // workflows directory is very likely already a configured root, so
        // fetching it unasked would report most of the library twice.
        const remote = host === undefined ? null : await remoteWorkflows(config, host);

        return {
          count: local.length + (remote?.workflows.length ?? 0),
          // Named even on a successful listing: an empty result is otherwise
          // indistinguishable from a directory nobody configured.
          roots: workflowRoots(config.env),
          ...(remote === null ? {} : { host: targetBody(remote.target) }),
          workflows: [...local, ...(remote?.workflows ?? [])],
          unreadable: listing.unreadable,
          ...(remote?.problem === undefined ? {} : { remote_unreadable: remote.problem }),
        };
      }),
  );

  server.registerTool(
    "describe_workflow",
    {
      title: "Describe a workflow's inputs",
      description:
        "Describe one workflow's settable inputs as a JSON Schema. Call this before run_workflow: " +
        "it is the only source of valid input addresses and of each value's type, allowed values " +
        "and bounds. Every property key is a slot address such as `3.seed` or `6.text`, and those " +
        "keys are exactly what run_workflow's `inputs` takes. A property's `default` is what the " +
        "workflow file currently holds, so a run with no inputs uses those values. `unresolved` " +
        "lists inputs whose constraints could not be recovered — usually an uninstalled custom " +
        "node, or a dropdown whose model list is empty on this machine; those inputs are still " +
        "settable, but the schema cannot say what they accept. `inert` lists addresses that exist " +
        "on the workflow but are decoys: ComfyUI's own graph execution overrides that widget from a " +
        "link to another node, so a value set there is silently never read — these are deliberately " +
        "absent from `schema.properties`, and run_workflow refuses a call that sets one. Each `inert` " +
        "entry names the upstream node that actually supplies the value, and a candidate address to " +
        "set instead where one could be identified. Reads node definitions from a " +
        "local cache — one per host, so two ComfyUIs with different models installed never " +
        "answer for each other — so it normally works while ComfyUI is stopped. Pass `host` to " +
        "describe the workflow against a particular ComfyUI's nodes; a workflow's constraints " +
        "genuinely differ between hosts, because the checkpoints and custom nodes do." +
        (config.autoLaunch
          ? " If that cache is missing or stale and ComfyUI is not running, this will start " +
            "ComfyUI to rebuild it, which can take a minute or two — but only for a host on this " +
            "machine, since ComfyUI cannot be started remotely."
          : ""),
      inputSchema: { workflow: workflowArgument, host: hostArgument },
      // Honest rather than flattering: with auto-launch on, this tool may start
      // a GPU process, and `readOnlyHint: true` is a promise that it will not.
      // See {@link registerTools}.
      annotations: { readOnlyHint: !config.autoLaunch, openWorldHint: true },
    },
    async ({ workflow, host }) =>
      toolAnswer(async () => {
        const target = await resolveTarget(config, host);
        const resolved = await resolveWorkflow(workflow, config, target, host !== undefined);
        const location = { ...address(target), cacheDir: config.cacheDir };
        // Fetched and cached in one step, then the *path* is handed to the CLI:
        // the join below needs the parsed document, and `slots --input` needs
        // the file (landmine #7). Reading it twice would cost a second 1.7MB.
        const objectInfo = await withObjectInfo(location, config, target);

        // A workflow that lives on the host has to become a file before the CLI
        // can read it. A local one already is one, and is deliberately not
        // copied: describing is the tool that works with ComfyUI stopped, and
        // it should not start writing temp directories to do it.
        const staged = resolved.source === "remote" ? await stageWorkflow(resolved) : null;
        try {
          const file = staged?.path ?? resolved.path;
          const listing = await listSlots(file, {
            ...address(target),
            objectInfoPath: objectInfoCachePath(location),
          });
          // A THIRD read of the same file, independent of the CLI entirely: the
          // decoy analysis is pure JS over the raw graph, and `listSlots` never
          // sees the link topology that decides it.
          const inertInputs = await inertInputsOfFile(file);
          const described = describeSlots(listing.slots, objectInfo, inertInputs);

          return {
            target: targetBody(target),
            workflow: { name: resolved.name, path: resolved.path, source: resolved.source },
            slot_count: listing.count,
            schema: described.schema,
            unresolved: described.unresolved,
            inert: described.inert,
          };
        } finally {
          staged?.dispose();
        }
      }),
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run a workflow",
      description:
        "Run a workflow, optionally overriding its inputs. Call describe_workflow first to learn " +
        "valid input addresses and value constraints; run_workflow inputs are keyed by slot " +
        "address such as `3.seed`. Setting an address describe_workflow lists under `inert` is " +
        "refused outright, before anything runs: that address is a decoy whose value ComfyUI's " +
        "own graph execution overrides from a link to another node, so the value would never take " +
        "effect. The workflow file is never modified — the values are applied to a private copy. " +
        "By DEFAULT this submits the run and returns immediately with a `prompt_id` and no " +
        "outputs: poll get_job with that id until `terminal` is true to collect them. Pass " +
        "`wait: true` to block until the run finishes and get the output paths back directly, " +
        "which suits a short image render and not a long video one. A `wait: true` run that " +
        "outlasts its budget is not lost — the error names the `prompt_id`, and the run carries " +
        "on inside ComfyUI. " +
        "To open a finished artifact: `outputs.files` are already paths on this machine, and " +
        "`outputs.local_paths` maps each URL in `outputs.urls` to the file it names here, where " +
        "that file exists. A URL missing from `local_paths` has no local path and must be " +
        "fetched. " +
        "Pass `host` to run on a particular ComfyUI; the run is remembered against it, so a later " +
        "get_job or cancel_job for the returned `prompt_id` finds it without being told again. A " +
        "run on another machine writes its artifacts on that machine, so `local_paths` is empty " +
        "for it — the URLs are the way in." +
        (config.autoLaunch
          ? " If ComfyUI is not running this will start ComfyUI first, so the first call after a " +
            "cold machine can take a minute or two before the run is even submitted; later calls " +
            "are immediate. That applies only to a host on this machine: a host that is not " +
            "answering elsewhere is reported, never started."
          : ""),
      inputSchema: {
        workflow: workflowArgument,
        host: hostArgument,
        fetch_outputs: fetchOutputsArgument,
        inputs: inputsArgument.optional(),
        wait: z
          .boolean()
          .default(false)
          .describe(
            "Block until the run finishes and return its outputs. False (the default) submits " +
              "the run and returns a prompt_id to poll with get_job.",
          ),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .optional()
          .describe(
            `How long to allow before giving up on the CLI. Defaults to ${WAIT_TIMEOUT_MS / 1000} ` +
              `seconds when wait is true and ${SUBMIT_TIMEOUT_MS / 1000} when it is not. Giving up ` +
              `does not stop the run; use cancel_job for that.`,
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflow, inputs, wait, timeout_seconds, host, fetch_outputs }) =>
      toolAnswer(async () => {
        const target = await resolveTarget(config, host);
        const resolved = await resolveWorkflow(workflow, config, target, host !== undefined);
        // Before anything else, and independent of the CLI entirely: a decoy
        // address writes its value nowhere ComfyUI reads it, so nothing below
        // this line — no CLI spawn, no launch, no submit — may run for a call
        // that sets one.
        await refuseInertInputs(resolved, inputs as SlotInputs | undefined);
        const timeoutMs =
          timeout_seconds === undefined
            ? wait
              ? WAIT_TIMEOUT_MS
              : SUBMIT_TIMEOUT_MS
            : timeout_seconds * 1_000;

        // Before anything else: `set-slot` validates against the server's node
        // schemas and `run` submits to it, so both steps below need one. Doing
        // this first also means the wait for a cold start is not counted
        // against the CLI budgets computed above.
        //
        // The instance is kept: it is the one that will run this workflow, so
        // its own output directory is the authority on where the artifacts land
        // (see `comfy/outputs.ts`'s resolveArtifactPath). Nothing is re-probed
        // afterwards — a second probe could answer with a different instance
        // from the one that did the work.
        const { instance } = await ensureRunning(config, target);

        // Finding 1. Resolved against the same server `set-slot` is about to
        // use, not the offline `/object_info` cache: a run already requires a
        // live one (see the comment above), and `type` comes from the
        // workflow's own widget layout, which `workflow slots` reports no
        // matter which schema source resolved it. See `resolveSlotTypes` for
        // why this is skipped on the ordinary path.
        // Skipped for a remote workflow: `workflow slots` reads a *file*, and
        // the only file this workflow will ever have is the prepared copy
        // `applySlots` is about to make — which does not exist yet. The cost is
        // one call's worth of finding 1's improvement, and `applySlots` already
        // treats an unknown slot type exactly as it always did.
        const slotTypes =
          resolved.source === "remote"
            ? {}
            : await resolveSlotTypes(resolved.path, inputs as SlotInputs | undefined, address(target));

        // A run needs a live server whatever happens, so `set-slot` is pointed
        // at the same server rather than at the offline cache: making the edit
        // work with ComfyUI down would buy a graph nothing could then submit.
        // describe_workflow is the opposite case, and does the opposite.
        const prepared = await applySlots(resolved.path, (inputs ?? {}) as SlotInputs, {
          ...address(target),
          slotTypes,
          contents: resolved.contents,
        });
        // Nothing may go between here and the call below. `runWorkflow` takes
        // ownership of the prepared copy and removes it in a `finally` on every
        // path, so it is the only owner — but only from the moment it is
        // entered, and anything that threw first would leak the temp directory.
        //
        // `requestedValues` is the caller's own `inputs`, not `prepared.applied`:
        // it is what builds `effective_parameters`, and the caller's original
        // values are what a mismatch is measured against.
        const run = await runWorkflow(prepared, {
          ...address(target),
          wait,
          timeoutMs,
          requestedValues: inputs as SlotInputs | undefined,
        });

        // Recorded before the answer is built, so that a job whose result a
        // caller is about to poll is already attributed. See `jobLedger.ts` for
        // why the alternative — guessing on a miss — is the failure this
        // exists to prevent.
        if (run.promptId !== null) recordJobHost(run.promptId, target);

        const fetched = await fetchIfAsked(run.outputs.urls, run.promptId, config, fetch_outputs);
        return {
          target: targetBody(target),
          ...runBody(resolved, prepared.applied, prepared.warnings, run, instance, fetched),
        };
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job status",
      description:
        "Report one job's status and, once it has finished, the files it produced. Takes the " +
        "`prompt_id` run_workflow returned. `terminal: true` means the job is over and `status` " +
        "says how it ended — `completed`, `error` or `cancelled`; anything else means it is still " +
        "queued or executing and is worth polling again. `outputs.files` are paths on this " +
        "machine and can be opened directly; `outputs.urls` have to be fetched — but first look " +
        "each URL up in `outputs.local_paths`, which maps a URL to the file it names on this " +
        "machine when that file is really there. A URL missing from `local_paths` has no local " +
        "path and must be fetched. A job started in the ComfyUI web interface can be polled here " +
        "too — but only on the host that ran it, so name that host. " +
        "For a run this server submitted, the host is remembered and `host` can be omitted. " +
        "Asking the WRONG ComfyUI about a real job answers `prompt_not_found`, exactly as an id " +
        "that never existed does, so a job that seems to have vanished is worth re-checking " +
        "against the right host before believing it is gone.",
      inputSchema: {
        prompt_id: promptIdArgument,
        host: hostArgument,
        fetch_outputs: fetchOutputsArgument,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ prompt_id, host, fetch_outputs }) =>
      toolAnswer(async () => {
        const decided = await decideJobTarget(config, prompt_id, host);
        const job = await getJobStatus(prompt_id, address(decided.target));
        const fetched = await fetchIfAsked(job.outputs.urls, job.promptId, config, fetch_outputs);
        return {
          ...jobTargetBody(decided),
          ...jobBody(job, await resolvingInstance(job.outputs.urls, decided.target), fetched),
        };
      }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a job",
      description:
        "Stop a queued or running job. Takes the `prompt_id` run_workflow returned. Answers with " +
        "which of three things happened: `cancelled` (the job was live and has been stopped), " +
        "`already_finished` (it had already ended, so there was nothing to stop — this is a " +
        "successful answer, not a failure), or `not_found` (no job anywhere with that id). " +
        "Cancelling frees the GPU immediately; the work already done is discarded. For a run this " +
        "server submitted, the host is remembered and `host` can be omitted; otherwise name the " +
        "ComfyUI the job is on. Note that `not_found` here is the CLI reporting no job of that id " +
        "in its own local records, which is a different thing from get_job's `prompt_not_found` " +
        "against a server — a job this machine never submitted can resist cancelling for that " +
        "reason alone.",
      inputSchema: { prompt_id: promptIdArgument, host: hostArgument },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ prompt_id, host }) =>
      toolAnswer(async () => {
        const decided = await decideJobTarget(config, prompt_id, host);
        return {
          ...jobTargetBody(decided),
          ...cancelBody(await cancelJob(prompt_id, address(decided.target))),
        };
      }),
  );

  registerManageHosts(server, config);
  if (config.allowLaunch) registerLaunch(server, config);
}

/**
 * The one tool that writes.
 *
 * A single tool with an `action` rather than five tools, because they share a
 * file, a backup, a validation pass and a set of refusals — five tools would be
 * five copies of all of that, and a model choosing between five names that all
 * edit the same file has a worse job than one filling in a field.
 *
 * It takes the registry's *path* from configuration and re-reads the file
 * itself, rather than being handed a loaded registry: the one action that
 * repairs `hosts.json` cannot require `hosts.json` to have loaded.
 */
function registerManageHosts(server: McpServer, config: ToolConfig): void {
  server.registerTool(
    "manage_hosts",
    {
      title: "Edit the ComfyUI host registry",
      description:
        "Add, change, remove or re-point the named ComfyUI hosts that list_hosts reports, by " +
        "rewriting the registry file. `add` needs a `name` and a `host`; `update` changes only " +
        "the fields given; `remove` deletes an entry and moves `default` if it pointed there; " +
        "`set_default` chooses which host a call with no `host` uses; `repair` rewrites a file " +
        "that has comments or trailing commas in it as strict JSON, changing no address, no port " +
        "and no default — `changes` comes back empty, which is the proof. " +
        "`auto_launch` may only be true for an address on THIS machine: `comfy launch` starts " +
        "ComfyUI wherever this server runs and has no way to reach another box, so asking for it " +
        "on a remote address is refused here rather than silently ignored later. " +
        "Every change copies the previous file to `hosts.json.bak-<timestamp>` first and reports " +
        "that path, writes through a temp file so no reader can see half a registry, and answers " +
        "with the registry re-read from disk — so what comes back is what the next call will see. " +
        "A wrong edit is undone with `mv`.",
      inputSchema: {
        action: z
          .enum(["add", "update", "remove", "set_default", "repair"])
          .describe("What to do. `repair` needs no other argument."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("The host to act on. Required for everything but `repair`."),
        host: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The address to connect to, e.g. \"127.0.0.1\" or \"100.86.199.90\". Required for " +
              "`add`. A wildcard bind address such as 0.0.0.0 is rewritten to loopback, because " +
              "it is where a server listens and not somewhere anything can connect.",
          ),
        port: z.number().int().min(MIN_PORT).max(MAX_PORT).optional().describe("Defaults to 8188."),
        auto_launch: z
          .boolean()
          .optional()
          .describe(
            "May this server start ComfyUI for this host when nothing answers? Only ever true " +
              "for an address on this machine. Defaults to whether the address is local.",
          ),
        note: z
          .string()
          .optional()
          .describe("A label for the box, e.g. \"Windows, RTX 4070 12GB, video\". Yours to use."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      toolAnswer(async () => {
        const result = await mutateHostRegistry(mutationOf(args), {
          env: config.env,
          defaultAddress: { host: config.host, port: config.port },
        });
        return {
          action: args.action,
          path: result.path,
          backup_path: result.backupPath,
          changes: result.changes,
          // A repair changes the file's text and nothing about its meaning, and
          // saying so out loud is the reassurance the action exists to give.
          reformatted: result.rewritten && result.changes.length === 0,
          registry: {
            default: result.registry.defaultName,
            count: result.registry.hosts.length,
            hosts: result.registry.hosts.map((entry) => ({
              name: entry.name,
              address: `${entry.host}:${entry.port}`,
              local: entry.local,
              auto_launch: entry.autoLaunch,
              note: entry.note,
              is_default: entry.name === result.registry.defaultName,
            })),
            warnings: result.registry.warnings,
          },
        };
      }),
  );
}

/**
 * The tool's flat arguments as one mutation.
 *
 * The `name` and `host` requirements are checked here rather than in the schema
 * because they differ per action, and a schema that made them conditional would
 * be a discriminated union of five shapes — harder for a model to fill in than
 * one flat object, for a check whose message can simply say which field is
 * missing.
 */
function mutationOf(args: {
  action: "add" | "update" | "remove" | "set_default" | "repair";
  name?: string;
  host?: string;
  port?: number;
  auto_launch?: boolean;
  note?: string;
}): HostMutation {
  if (args.action === "repair") return { action: "repair" };

  const name = args.name;
  if (name === undefined) {
    throw new ToolArgumentError(`action ${JSON.stringify(args.action)} needs a \`name\`.`);
  }
  if (args.action === "remove") return { action: "remove", name };
  if (args.action === "set_default") return { action: "set_default", name };

  if (args.action === "add") {
    if (args.host === undefined) {
      throw new ToolArgumentError("action \"add\" needs a `host` — the address to connect to.");
    }
    return {
      action: "add",
      name,
      host: args.host,
      port: args.port,
      autoLaunch: args.auto_launch,
      note: args.note,
    };
  }
  return {
    action: "update",
    name,
    host: args.host,
    port: args.port,
    autoLaunch: args.auto_launch,
    note: args.note,
  };
}

/**
 * The ComfyUI startup flags, flattened rather than nested under an `args`
 * object: one level is easier for a model to fill in, and there is nothing to
 * group them against.
 */
function registerLaunch(server: McpServer, config: ToolConfig): void {
  server.registerTool(
    "launch_comfyui",
    {
      title: "Launch ComfyUI",
      description:
        "Start a ComfyUI server, but only if nothing is already answering at the address these " +
        "arguments name (falling back to the address this server talks to). Refuses with " +
        "`outcome: \"already_running\"` — carrying that instance, never a different one — only " +
        "when that specific address is occupied; an instance running elsewhere does not block " +
        "this call, so launching on a free port succeeds even while ComfyUI Desktop is running " +
        "on its own. When a launch does proceed alongside another running instance, `warnings` " +
        "on the result says so, because the two compete for the same VRAM and the same shared " +
        "model directory. On success it waits until the new server actually answers, which can " +
        "take a minute or two while it loads. " +
        "ComfyUI can only ever be started on THIS machine: `comfy launch` runs it wherever this " +
        "server runs and has no way to reach another box. A `host`, or a `listen` address, that " +
        "is not on this machine is refused outright rather than attempted — attempting it would " +
        "start a ComfyUI here and then wait for a machine that was never going to answer. " +
        "Registered only when MCP_COMFYUI_ALLOW_LAUNCH=1.",
      inputSchema: {
        host: hostArgument,
        listen: z
          .string()
          .min(1)
          .optional()
          .describe("Bind address. `0.0.0.0` binds every interface. Defaults to ComfyUI's own."),
        port: z.number().int().min(MIN_PORT).max(MAX_PORT).optional().describe("Port to bind."),
        lowvram: z.boolean().optional(),
        novram: z.boolean().optional(),
        highvram: z.boolean().optional(),
        cpu: z.boolean().optional().describe("Run without an accelerator. Very slow."),
        output_directory: z.string().min(1).optional(),
        input_directory: z.string().min(1).optional(),
        extra_model_paths_config: z.string().min(1).optional(),
        disable_auto_launch: z
          .boolean()
          .optional()
          .describe("Stop ComfyUI opening a browser window on a machine nobody is looking at."),
        verbose: z.boolean().optional(),
        extra_args: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "ComfyUI startup arguments this tool does not name, passed through verbatim, e.g. " +
              "[\"--fast\"]. Last wins, so an entry here overrides the option of the same name.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      toolAnswer(async () => {
        const launchArgs: LaunchArgs = {
          listen: args.listen,
          port: args.port,
          lowvram: args.lowvram,
          novram: args.novram,
          highvram: args.highvram,
          cpu: args.cpu,
          outputDirectory: args.output_directory,
          inputDirectory: args.input_directory,
          extraModelPathsConfig: args.extra_model_paths_config,
          disableAutoLaunch: args.disable_auto_launch,
          verbose: args.verbose,
        };
        const target = await resolveTarget(config, args.host);
        const result = await launchInstance({
          ...address(target),
          workspace: config.workspace,
          args: launchArgs,
          extraArgs: args.extra_args ?? [],
        });
        return {
          target: targetBody(target),
          outcome: result.outcome,
          instance: instanceBody(result.instance),
          ...(result.outcome === "launched" ? { warnings: result.warnings } : {}),
        };
      }),
  );
}
