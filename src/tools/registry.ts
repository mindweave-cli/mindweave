/**
 * registry.ts — the one list of tools the engine can use.
 *
 * Adding a capability to Mindweave is: write the tool file, import it here, add it
 * to TOOLS. The engine reads from this registry and nowhere else, so it never
 * needs to change when tools come and go.
 */
import type { Tool, ToolContext, ToolSchema } from "./types.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { edit } from "./edit.js";
import { runCommand } from "./runCommand.js";
import { search } from "./search.js";
import { outlineTool, definitionTool, referencesTool } from "./codeIntel.js";
import { readSymbolTool } from "./readSymbol.js";
import { replaceSymbolBody } from "./replaceSymbol.js";
import { web } from "./web.js";
import { screenshot } from "./screenshot.js";
import { viewImage } from "./viewImage.js";
import { exitPlan } from "./exitPlan.js";
import { todoWrite } from "./todo.js";
import { useSkill } from "./useSkill.js";
import { governor, skillTool } from "./governorTools.js";
import { saveMemoryTool } from "./saveMemory.js";
import { askUserTool } from "./askUser.js";
import { workspaceTool } from "./workspace.js";
import { shellsTool, killShell } from "./shellTools.js";
import { spawnSubagent } from "./subagent.js";
import { sessionsTool } from "./sessionTools.js";
import { findTools } from "./mcpSearch.js";
import { mcpResourceTool } from "./mcpResources.js";
import { mcpServer } from "./mcpAdd.js";
import { mindweaveStatus } from "./mindweaveStatus.js";

export const TOOLS: Tool[] = [
  // Discovery (read-only)
  search,
  readFile,
  web,
  // Code intelligence (read-only, chassis-backed)
  outlineTool,
  definitionTool,
  referencesTool,
  readSymbolTool,
  // Background shells (read-only: inspect long-running commands)
  shellsTool,
  // External integrations (read-only: finds MCP tools, and reads the DATA servers expose
  // as opposed to the actions they perform)
  findTools,
  mcpResourceTool,
  // Own history (read-only: what this agent did in this project before)
  sessionsTool,
  // Skills (read-only: loads a procedure into context on demand)
  useSkill,
  // Clarification (read-only: asks the user a focused question, changes nothing)
  askUserTool,
  // Sight (read-only: looks at a picture, changes nothing)
  viewImage,
  screenshot,
  // Planning (read-only, and offered only while planning — see `planOnly`)
  exitPlan,
  // Action (mutating)
  writeFile,
  edit,
  replaceSymbolBody,
  spawnSubagent,
  runCommand,
  todoWrite,
  workspaceTool,
  killShell,
  // Cross-session memory (mutating: persists what the model is asked to remember)
  saveMemoryTool,
  // Governor (mutating: persist a rule / forbidden path / skill for the project)
  governor,
  mcpServer,
  mindweaveStatus,
  skillTool,
];

/** Look up a tool by the name the model called. */
export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * The OpenAI-style `tools[]` array we send to the provider so the model knows
 * what it can call. Built straight from the registry — one source of truth.
 *
 * In `planMode` (the CLI's Architect mode) only read-only tools are advertised,
 * so the model plans and researches without ever being offered edit/write/run.
 * `readOnlyOnly` does the same filtering without the plan framing — used to make a
 * research sub-agent read-only. Execution is guarded independently in the engine,
 * so a stray mutating call is still refused — this just keeps the model from
 * reaching for one.
 */
export function toolSchemas(
  opts: { planMode?: boolean; readOnlyOnly?: boolean; ctx?: ToolContext } = {},
): ToolSchema[] {
  const readOnly = opts.planMode || opts.readOnlyOnly;
  // `planOnly` runs the filter the other way: those tools exist BECAUSE planning is
  // happening, so they appear only in plan mode and are hidden the rest of the time.
  // A read-only sub-agent is not planning, so it does not get them either.
  //
  // `deferred` is the third filter: a deferred tool is held back UNTIL the model has
  // surfaced it through find_tools, which records it in `ctx.activatedTools`. From then on
  // it is advertised like any other tool.
  //
  // Delivering the schema only in the search RESULT (an appended message) is not enough on
  // its own: a strict function-calling model — every OpenAI-compatible provider (GLM,
  // DeepSeek, Qwen, …) — only emits a tool call for a function that is actually in the
  // request's `tools` array. A schema shown as text is callable in name only; the model
  // reads it, "knows" it should use the tool, and cannot, so it stalls. Adding the tool
  // here once activated is what makes it real. The cost is one prefix rebuild the first
  // time each capability is used — deliberately paid, because a tool that cannot be called
  // is worse than a cache miss. Activation is monotonic (the set only grows), so the
  // rebuild happens once per capability, not once per call. Nothing activated → identical
  // bytes to before, so the common session pays nothing.
  const activated = opts.ctx?.activatedTools;
  const tools = (readOnly ? TOOLS.filter((tool) => tool.readOnly) : TOOLS)
    .filter((tool) => (tool.planOnly ? opts.planMode === true : true))
    .filter((tool) => !tool.deferred || (activated?.has(tool.name) ?? false))
    // `relevantWhen` needs the live session; with no ctx (a schema-shape test, a
    // count) the tool is shown, because hiding it would be a false negative about
    // what the registry contains.
    .filter((tool) => !tool.relevantWhen || !opts.ctx || tool.relevantWhen(opts.ctx));
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

