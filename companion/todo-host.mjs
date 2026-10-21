// `/todo edit`: OMP's text-mode /todo refuses it (it needs the TUI's $EDITOR round-trip). The companion runs the TUI's
// path (TodoCommandController#editInExternalEditor) with the dashboard's editor dialog in place of $EDITOR; every other
// /todo form still reaches OMP's own handler.

export const host = {
 name: 'todo edit',
 async load({ m }) {
  const { getLatestTodoPhasesFromEntries, markdownToPhases, phasesToMarkdown, USER_TODO_EDIT_CUSTOM_TYPE } = m.todo;
  for (const [name, v] of Object.entries({ getLatestTodoPhasesFromEntries, markdownToPhases, phasesToMarkdown, USER_TODO_EDIT_CUSTOM_TYPE })) if (!v) throw new Error(`tools/todo.ts has no ${name}`);
  return io => new TodoEdit(io, m.todo);
 },
};

// The TUI's note to the agent after a manual edit (todo-command-controller.ts buildSystemReminder).
function reminder(action, phases, phasesToMarkdown) {
 const md = phases.length === 0 ? '(empty)' : phasesToMarkdown(phases).trimEnd();
 return ['<system-reminder>', `The user manually modified the todo list (${action}).`, 'Current todo list:', '', md, '</system-reminder>'].join('\n');
}

class TodoEdit {
 names = ['todo'];
 #io; #todo;
 constructor(io, todo) { this.#io = io; this.#todo = todo; }
 // OMP's /todo entry (with its edit subcommand) is already in the catalog.
 commands() { return []; }
 claims(parsed) { return parsed.name === 'todo' && parsed.args.trim().split(/\s+/)[0].toLowerCase() === 'edit'; }

 async run() {
  const { session, ui, output, notice } = this.#io, t = this.#todo;
  const fromEntries = t.getLatestTodoPhasesFromEntries(session.sessionManager.getBranch());
  const current = fromEntries.length > 0 ? fromEntries : session.getTodoPhases();
  const initial = current.length > 0 ? t.phasesToMarkdown(current) : '# Todos\n- [ ] (replace this with your tasks)\n';
  const edited = await ui.editor('Edit todos (Markdown)', initial);
  if (edited === undefined) { notice('warning', 'Editor closed without saving; todos unchanged.'); return { consumed: true }; }
  const { phases, errors } = t.markdownToPhases(edited);
  if (errors.length > 0) throw new Error(`Could not parse Markdown:\n  ${errors.join('\n  ')}`);
  // TodoCommandController#commit: persist, then tell the agent on its next turn.
  session.setTodoPhases(phases);
  session.sessionManager.appendCustomEntry(t.USER_TODO_EDIT_CUSTOM_TYPE, { phases });
  const message = { role: 'developer', content: [{ type: 'text', text: reminder('/todo edit', phases, t.phasesToMarkdown) }], attribution: 'user', timestamp: Date.now() };
  session.agent.appendMessage(message);
  session.sessionManager.appendMessage(message);
  output(`Todos updated from editor: ${phases.length} phase(s), ${phases.reduce((n, p) => n + p.tasks.length, 0)} task(s).`);
  return { consumed: true };
 }
}
