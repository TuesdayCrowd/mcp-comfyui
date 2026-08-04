import { z } from "zod";
import { snippet } from "../comfy/envelope.ts";
import { ComfyCliError, runComfy } from "../comfy/exec.ts";
import { DEFAULT_PORT, resolveHost } from "../comfy/target.ts";

/**
 * `comfy workflow slots` enumerates the agent-tweakable inputs of a workflow:
 * the widget-backed values a caller may actually set. This module is the typed
 * wrapper over that command.
 *
 * It reports types but never constraints — a COMBO arrives bare, with no
 * allowed values, and a numeric arrives with no bounds (landmine #6). Task 2.3
 * joins this listing against `/object_info` to recover them, which is the only
 * reason `node_type` and `name` are carried through.
 */

/** The one error code this module says more about than the CLI does. */
const NOT_FRONTEND_FORMAT = "workflow_not_frontend_format";

/**
 * One settable input.
 *
 * `type` is an open string, not an enum. The values seen in practice are `INT`,
 * `FLOAT`, `STRING`, `BOOLEAN` and `COMBO`, but custom nodes declare their own
 * widget types and upstream adds more — the same append-only reasoning that
 * keeps `error.code` an open string in `comfy/envelope.ts`. An unrecognised
 * type must degrade one slot, never reject the listing.
 *
 * Unknown keys are stripped rather than passed through: this type is what Task
 * 2.3 reads every slot through, and an index signature would turn every typo
 * into a silent `unknown` instead of a compile error. A field upstream adds can
 * be adopted here deliberately when it appears.
 */
export const SlotSchema = z.object({
  /**
   * `<instance_id>.<input_name>` for a top-level node, but **opaque**: a slot
   * inside an expanded subgraph carries the enclosing instance too, so an
   * address may have more than two segments. It is the key `set-slot` accepts,
   * so it is passed through exactly as received and never rebuilt from parts.
   */
  address: z.string(),
  /** The input's name on its node, and the key into `object_info`'s input map. */
  name: z.string(),
  type: z.string(),
  /**
   * What the workflow file currently holds. `null` is allowed because an unset
   * optional widget is representable, and rejecting a whole listing over one
   * absent value would be disproportionate; Task 2.3 reads it as "no default".
   */
  current_value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  /** The node's id within the graph. Not sufficient to rebuild `address`. */
  instance_id: z.string(),
  /** The `object_info` key this slot's constraints live under. */
  node_type: z.string(),
});

export type Slot = z.infer<typeof SlotSchema>;

/**
 * The payload's shape. Field *values* are treated as open registries above;
 * the set of fields is the contract, and a listing that cannot say which
 * workflow it describes is not something the callers downstream should have to
 * defend against.
 */
const SlotsPayloadSchema = z.object({
  workflow: z.string(),
  id: z.string(),
  slots: z.array(SlotSchema),
});

export interface SlotListing {
  /** The workflow file as the CLI resolved it — absolute, whatever was passed. */
  workflow: string;
  /** The CLI's identifier for the workflow, in practice its filename stem. */
  id: string;
  /**
   * How many slots this listing carries. Derived from the array rather than
   * read from the payload's own tally, so it cannot disagree with what a caller
   * iterating `slots` will see.
   */
  count: number;
  slots: Slot[];
}

export interface ListSlotsOptions {
  /** ComfyUI's address, defaulting to `127.0.0.1`. Ignored with `objectInfoPath`. */
  host?: string;
  /** Defaults to `8188`. Ignored with `objectInfoPath`. */
  port?: number;
  /**
   * A saved `/object_info` document — `comfy/objectInfo.ts` writes one — which
   * lets the CLI resolve node schemas with no server running (landmine #7).
   * **Takes precedence over `host`/`port`**, which are then not sent at all.
   */
  objectInfoPath?: string;
  /** Budget for the CLI call. Defaults to `runComfy`'s 120 seconds. */
  timeoutMs?: number;
}

/**
 * The CLI answered, but with something this server cannot read as a slot
 * listing. Distinct from {@link ComfyCliError} on purpose: that is the CLI
 * reporting a failure it understood, whereas this is a contract mismatch, and
 * an operator can only act on the difference if we keep it.
 */
export class SlotListingParseError extends Error {
  override readonly name = "SlotListingParseError";
  readonly workflowPath: string;

  constructor(workflowPath: string, data: unknown, cause: z.ZodError) {
    super(
      `comfy workflow slots returned a payload this server could not read for ${workflowPath}\n` +
        `  received: ${snippet(describe(data))}\n${z.prettifyError(cause)}`,
      { cause },
    );
    this.workflowPath = workflowPath;
  }
}

/** The payload came from `JSON.parse`, so it cannot be cyclic. */
function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Where the CLI is to get node schemas from. The two sources are alternatives,
 * so exactly one is sent: passing both would leave the CLI to arbitrate between
 * a cache and a server that may disagree, and the cache wins because a caller
 * that took the trouble to supply one is asking for a deterministic, offline
 * answer. Host and port are sent explicitly even at their defaults so the
 * address never depends on whatever workspace config the CLI finds.
 */
function schemaSourceArgs(opts: ListSlotsOptions): string[] {
  if (opts.objectInfoPath !== undefined) return ["--input", opts.objectInfoPath];
  return ["--host", resolveHost(opts.host), "--port", String(opts.port ?? DEFAULT_PORT)];
}

/**
 * `slots` only reads the frontend/UI format the ComfyUI editor saves. API
 * format is the other thing a `.json` in a workflow directory plausibly is, and
 * the CLI's code alone does not tell the operator which export menu item to
 * pick.
 */
function apiFormatGuidance(workflowPath: string): string {
  return (
    `${workflowPath} appears to be in API (prompt) format; \`comfy workflow slots\` reads only ` +
    `the frontend/UI format the ComfyUI editor saves — a graph with \`nodes\` and \`links\`.\n` +
    `In ComfyUI use Workflow → Export (not Export (API)), or point at the editor's own copy ` +
    `under user/default/workflows.`
  );
}

/**
 * Run the command, enriching the one failure whose fix is not obvious from its
 * code. The error keeps its type, code, `where`, `hint` and `details`: callers
 * branch on the append-only code registry, and swapping in a bespoke type per
 * code would both break that and lose what the CLI said.
 */
async function fetchPayload(workflowPath: string, opts: ListSlotsOptions): Promise<unknown> {
  const args = ["workflow", "slots", workflowPath, ...schemaSourceArgs(opts)];
  try {
    // `--skip-prompt` is runComfy's to prepend; adding it here would repeat it.
    return await runComfy(args, { timeoutMs: opts.timeoutMs });
  } catch (err) {
    if (err instanceof ComfyCliError && err.code === NOT_FRONTEND_FORMAT) {
      // Rewritten in place rather than re-thrown as a new error: ComfyCliError
      // keeps only its formatted message and discards the CLI's raw one, so
      // re-constructing would double-prefix.
      //
      // INVARIANT: nothing may read `err.stack` between `runComfy` throwing and
      // this line. A JSC stack embeds the `Name: message` header and is
      // memoized on first read, so a logger or retry wrapper added in that
      // window would freeze the pre-enrichment text into `.stack` while
      // `.message` carries the guidance, and the two would then disagree with
      // nothing to say why. If you need to read the stack there, append this
      // guidance where the error is constructed instead.
      err.message = `${err.message}\n${apiFormatGuidance(workflowPath)}`;
    }
    throw err;
  }
}

/**
 * Every settable input of one workflow.
 *
 * @param workflowPath  the workflow file, in ComfyUI's frontend/UI format.
 * @throws {SlotListingParseError} the CLI's payload was not a slot listing.
 * @throws {ComfyCliError} the CLI reported a failure; `workflow_not_frontend_format`
 * carries added guidance, every other code passes through as the CLI wrote it.
 * @throws {ComfyTimeoutError} the call exceeded `timeoutMs`.
 * @throws {ComfyUnavailableError} the `comfy` binary could not be started.
 */
export async function listSlots(
  workflowPath: string,
  opts: ListSlotsOptions = {},
): Promise<SlotListing> {
  const data = await fetchPayload(workflowPath, opts);

  const result = SlotsPayloadSchema.safeParse(data);
  if (!result.success) throw new SlotListingParseError(workflowPath, data, result.error);

  return { ...result.data, count: result.data.slots.length };
}
