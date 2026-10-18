/**
 * toolAliases.ts — the other names a model gives Mindweave's tools.
 *
 * Models arrive with the tool names of other agent programs in their habits: `bash`, `grep`, `question`,
 * `str_replace_editor`. A call to one of those is an error that tells the model nothing it can act on unless it says
 * which of OUR tools it meant and what that tool does. This is the list that lets it say so. Pure.
 *
 * A name is compared with the case and the punctuation taken out, so `ask-user`, `Ask_User` and `askuser` are one.
 */

/** Our tool name → the other names it goes by. Each alias belongs to one tool only. */
export const TOOL_ALIASES: Record<string, string[]> = {
  ask_user: ["question", "questions", "ask", "asking", "ask_question", "ask_the_user", "ask_human", "clarify", "clarification", "prompt_user", "user_input", "request_input", "confirm", "ask_for_input", "askuserquestion"],
  read_file: ["read", "cat", "open", "open_file", "view", "view_file", "get_file", "file_read", "read_files", "readfile", "fetch_file", "show_file", "read_text_file"],
  write_file: ["write", "create", "create_file", "save", "save_file", "new_file", "file_write", "writefile", "overwrite_file", "make_file", "write_to_file"],
  edit: ["edit_file", "replace", "str_replace", "str_replace_editor", "string_replace", "apply_patch", "patch", "modify", "modify_file", "update_file", "replace_in_file", "editfile", "multi_edit", "multiedit", "apply_diff", "insert"],
  run_command: ["bash", "shell", "sh", "cmd", "powershell", "pwsh", "run", "exec", "execute", "terminal", "command", "run_shell", "run_terminal_cmd", "run_bash", "shell_command", "execute_command", "run_cmd", "console"],
  search: ["grep", "find", "ripgrep", "rg", "search_files", "search_code", "code_search", "codebase_search", "find_in_files", "grep_search", "glob", "file_search", "find_files", "ls", "list_files", "search_text"],
  todo_write: ["todo", "todos", "todowrite", "todo_list", "task_list", "tasks", "update_todos", "write_todos", "plan_tasks", "checklist"],
  web: ["fetch", "web_fetch", "webfetch", "http", "http_get", "get_url", "curl", "browse", "browse_url", "read_url", "open_url", "visit", "download", "web_search", "websearch", "search_web", "internet_search", "google"],
  shells: ["jobs", "list_shells", "background", "bg", "background_jobs", "list_jobs", "shell_status", "bashoutput", "bash_output", "get_shell_output", "check_shell"],
  kill_shell: ["kill", "stop_shell", "killshell", "kill_process", "stop_process", "stop_command", "kill_job", "kill_bash", "killbash", "terminate"],
  exit_plan: ["exit_plan_mode", "exitplanmode", "plan_done", "submit_plan", "finish_plan", "present_plan", "end_plan", "approve_plan"],
  spawn_subagent: ["subagent", "sub_agent", "agent", "task", "spawn_agent", "delegate", "dispatch_agent", "launch_agent", "run_agent", "spawn_task", "worker"],
  view_image: ["image", "look_at_image", "see_image", "open_image", "show_image", "read_image", "view_picture", "describe_image"],
  screenshot: ["capture", "screen", "take_screenshot", "screen_capture", "capture_screen", "screengrab", "snapshot", "window_capture"],
  ui: ["click", "type", "press", "hover", "computer", "computer_use", "browser", "browser_action", "interact", "gui", "drive_app", "test_app", "playwright", "puppeteer"],
  outline: ["symbols", "list_symbols", "file_outline", "structure", "code_outline", "document_symbols"],
  definition: ["go_to_definition", "goto_definition", "find_definition", "lookup_definition", "jump_to_definition"],
  references: ["find_references", "find_usages", "usages", "callers", "who_calls", "lookup_references"],
  read_symbol: ["get_symbol", "symbol", "read_function", "read_class", "show_symbol", "view_symbol"],
  replace_symbol_body: ["edit_symbol", "replace_function", "rewrite_symbol", "replace_symbol", "update_symbol", "replace_method"],
  save_memory: ["memory", "remember", "save_note", "write_memory", "memorize", "note", "store_memory"],
  use_skill: ["skill", "run_skill", "load_skill", "invoke_skill", "activate_skill", "get_skill"],
  find_tools: ["list_tools", "tools", "tool_search", "search_tools", "available_tools", "discover_tools", "toolsearch", "what_tools"],
  workspace: ["workspaces", "projects", "list_projects", "project_info", "workspace_info", "switch_project"],
  sessions: ["history", "list_sessions", "past_sessions", "previous_sessions", "conversation_history", "search_sessions"],
  mcp_resource: ["resource", "read_resource", "mcp_read", "get_resource", "list_resources", "readmcpresource"],
  mcp_server: ["mcp", "add_mcp", "mcp_add", "install_mcp", "manage_mcp", "mcp_servers"],
};

/** A name with the case, spaces, dashes and underscores taken out. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Normalized alias (and normalized own name) → the tool it means. Built once. */
const REVERSE: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [tool, aliases] of Object.entries(TOOL_ALIASES)) {
    map.set(normalize(tool), tool);
    for (const a of aliases) if (!map.has(normalize(a))) map.set(normalize(a), tool);
  }
  return map;
})();

/** The tool a made-up name stands for, or null. Only a tool that exists in `known` is returned. */
export function aliasTarget(name: string, known: readonly string[]): string | null {
  const target = REVERSE.get(normalize(name));
  return target && known.includes(target) ? target : null;
}

/** The first couple of sentences of a tool's description, short enough to read in an error message. */
export function shortExplanation(description: string, max = 320): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [flat];
  let out = "";
  for (const s of sentences.slice(0, 2)) {
    if ((out + s).length > max && out) break;
    out += s;
  }
  out = out.trim() || flat;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
