//! todo_write — port of `app/core/agent/tools/todo-write.ts` ().
//! Single flat per-session todo list with a full-replacement model (the
//! COMPLETE list replaces the previous on every call). State lives in
//! [`TodoState`] — the port of the TS module-level `sessionTodos` map +
//! `TodoBus`. The orchestrator shares one instance per app via
//! [`crate::ToolContext::todo_state`] and subscribes once to forward
//! [`TodosUpdated`] to the renderer (the TS `TodosUpdatedEvent` push).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::permission::RiskTier;
use crate::{Tool, ToolContext, ToolDisplay, ToolError, ToolOutcome, ToolSpec};

const DESCRIPTION: &str = "Maintain a structured todo list for the current task. Call this BEFORE starting multi-step work to plan, then UPDATE statuses as you progress. Send the COMPLETE list on every call — it REPLACES the previous list (do not send deltas). Mark completed items \"completed\", the one you are working on \"in_progress\", pending ones \"pending\", and items you are dropping as \"cancelled\". Exactly one item may be in_progress at a time. The user sees this list live, so keep it accurate in real time — mark an item completed as soon as its work is done and verified. Use for tasks with 3+ distinct steps; skip for simple one-shot answers.";

/// TS `TodoStatus` — serializes to the renderer's wire strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl TodoStatus {
    /// Parse the schema enum strings; anything else is a model error the
    /// SDK path's zod validation would have rejected.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "completed" => Some(Self::Completed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// The checkbox mark shared by tool output and the `# Current Plan`
    /// prompt lines (`[x]`/`[~]`/`[-]`/`[ ]`).
    pub fn mark(&self) -> &'static str {
        match self {
            Self::Completed => "[x]",
            Self::InProgress => "[~]",
            Self::Cancelled => "[-]",
            Self::Pending => "[ ]",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoPriority {
    High,
    Medium,
    Low,
}

/// Field-compatible with the renderer's `TodoItem`
/// (`{ content, status, priority? }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<TodoPriority>,
}

/// Port of the TS `TodosUpdatedEvent` (`shared/rpc.ts`) — the renderer's
/// `todosUpdated` push payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodosUpdated {
    pub session_id: String,
    pub todos: Vec<TodoItem>,
}

type TodoListener = Arc<dyn Fn(&TodosUpdated) + Send + Sync>;

/// Session-scoped todo store + change bus. The TS original was a pair of
/// module singletons (`sessionTodos` Map + `todoEvents` TodoBus) whose
/// sharing was load-bearing — the comment on `sharedStore()` warns that a
/// second instance's writes get clobbered. Here the sharing is explicit:
/// the orchestrator mints ONE `Arc<TodoState>` per app, threads it into
/// every [`ToolContext`], and subscribes to forward [`TodosUpdated`] to
/// the renderer (T7 wires persistence onto the same subscription).
#[derive(Default)]
pub struct TodoState {
    sessions: Mutex<HashMap<String, Vec<TodoItem>>>,
    listeners: Mutex<Vec<(u64, TodoListener)>>,
    next_listener_id: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for TodoState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TodoState").finish_non_exhaustive()
    }
}

impl TodoState {
    pub fn shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock_sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<TodoItem>>> {
        self.sessions.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// TS `getSessionTodos` — current list for a session (empty when unset).
    pub fn todos(&self, session_id: &str) -> Vec<TodoItem> {
        self.lock_sessions()
            .get(session_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Store the full-replacement list and notify subscribers.
    pub fn set(&self, session_id: &str, todos: Vec<TodoItem>) {
        self.lock_sessions()
            .insert(session_id.to_owned(), todos.clone());
        self.emit(TodosUpdated {
            session_id: session_id.to_owned(),
            todos,
        });
    }

    /// TS `clearSessionTodos` — drop the list and notify with an empty one.
    pub fn clear(&self, session_id: &str) {
        self.lock_sessions().remove(session_id);
        self.emit(TodosUpdated {
            session_id: session_id.to_owned(),
            todos: Vec::new(),
        });
    }

    /// TS `TodoBus::on` — returns the id for [`TodoState::unsubscribe`].
    /// Listeners run synchronously on the writing thread; keep them cheap.
    pub fn subscribe(&self, listener: impl Fn(&TodosUpdated) + Send + Sync + 'static) -> u64 {
        use std::sync::atomic::Ordering;
        let mut listeners = self.listeners.lock().unwrap_or_else(|p| p.into_inner());
        let id = self.next_listener_id.fetch_add(1, Ordering::Relaxed) + 1;
        listeners.push((id, Arc::new(listener)));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.listeners
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|(lid, _)| *lid != id);
    }

    fn emit(&self, event: TodosUpdated) {
        let listeners = self.listeners.lock().unwrap_or_else(|p| p.into_inner());
        for (_, f) in listeners.iter() {
            f(&event);
        }
    }
}

/// Render the session's todos as `# Current Plan` body lines for the system
/// prompt — same mark syntax as the tool result so the list reads
/// identically in the prompt and in tool output.
pub fn render_todo_plan_lines(todos: &[TodoItem]) -> Vec<String> {
    todos
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{} {}. {}", t.status.mark(), i + 1, t.content))
        .collect()
}

pub(crate) fn run_todo_write(
    todos: Vec<TodoItem>,
    session_id: &str,
    state: &TodoState,
) -> ToolOutcome {
    if todos.is_empty() {
        return ToolOutcome::failed("Missing or empty required arg: todos");
    }

    let in_progress = todos
        .iter()
        .filter(|t| t.status == TodoStatus::InProgress)
        .count();
    if in_progress > 1 {
        return ToolOutcome::failed(format!(
            "At most one todo can be in_progress at a time; got {in_progress}. Fix and retry."
        ));
    }

    let sid = if session_id.is_empty() {
        "default"
    } else {
        session_id
    };
    state.set(sid, todos.clone());

    let done = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Completed)
        .count();
    let cancelled = todos
        .iter()
        .filter(|t| t.status == TodoStatus::Cancelled)
        .count();
    let next = todos
        .iter()
        .find(|t| t.status == TodoStatus::InProgress)
        .or_else(|| todos.iter().find(|t| t.status == TodoStatus::Pending));
    let mut summary = format!("{done}/{} done", todos.len());
    if cancelled > 0 {
        summary.push_str(&format!(" · {cancelled} cancelled"));
    }
    if let Some(next) = next {
        summary.push_str(&format!(" · next: {}", next.content));
    }

    let text = todos
        .iter()
        .enumerate()
        .map(|(i, t)| format!("{} {}. {}", t.status.mark(), i + 1, t.content))
        .collect::<Vec<_>>()
        .join("\n");

    ToolOutcome::executed(format!("Todo list updated ({summary})."))
        .with_display(ToolDisplay::Text { text })
        .with_meta(summary)
}

fn parse_todos(args: &serde_json::Value) -> Result<Vec<TodoItem>, ToolError> {
    let Some(raw) = args.get("todos").and_then(|v| v.as_array()) else {
        return Ok(Vec::new());
    };
    let mut todos = Vec::with_capacity(raw.len());
    for item in raw {
        let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let status_str = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let Some(status) = TodoStatus::parse(status_str) else {
            return Err(ToolError::InvalidArgs {
                tool: "todo_write".into(),
                message: format!(
                    "invalid status {status_str:?} (expected pending | in_progress | completed | cancelled)"
                ),
            });
        };
        if content.is_empty() {
            return Err(ToolError::InvalidArgs {
                tool: "todo_write".into(),
                message: "todo item requires non-empty content".into(),
            });
        }
        let priority = match item.get("priority").and_then(|v| v.as_str()) {
            None | Some("") => None,
            Some("high") => Some(TodoPriority::High),
            Some("medium") => Some(TodoPriority::Medium),
            Some("low") => Some(TodoPriority::Low),
            Some(other) => {
                return Err(ToolError::InvalidArgs {
                    tool: "todo_write".into(),
                    message: format!("invalid priority {other:?} (expected high | medium | low)"),
                });
            }
        };
        todos.push(TodoItem {
            content: content.to_owned(),
            status,
            priority,
        });
    }
    Ok(todos)
}

pub struct TodoWriteTool;

impl Tool for TodoWriteTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: "todo_write".into(),
            description: DESCRIPTION.into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The complete todo list. Sent in full on every call — replaces the previous list.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": { "type": "string", "description": "Short description of the task." },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed", "cancelled"],
                                    "description": "pending = not started, in_progress = actively working (at most one), completed = done + verified, cancelled = dropped."
                                },
                                "priority": {
                                    "type": "string",
                                    "enum": ["high", "medium", "low"],
                                    "description": "Optional priority."
                                }
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    fn risk_tier(&self) -> RiskTier {
        RiskTier::ReadOnly
    }

    fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<ToolOutcome, ToolError> {
        let todos = parse_todos(&args)?;
        Ok(run_todo_write(todos, &ctx.session_id, &ctx.todo_state))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OutcomeStatus;
    use serde_json::json;

    fn item(content: &str, status: TodoStatus) -> TodoItem {
        TodoItem {
            content: content.into(),
            status,
            priority: None,
        }
    }

    #[test]
    fn renders_the_four_status_marks_distinctly() {
        let lines = render_todo_plan_lines(&[
            item("Done work", TodoStatus::Completed),
            item("Active work", TodoStatus::InProgress),
            item("Dropped work", TodoStatus::Cancelled),
            item("Future work", TodoStatus::Pending),
        ]);
        assert_eq!(
            lines,
            vec![
                "[x] 1. Done work",
                "[~] 2. Active work",
                "[-] 3. Dropped work",
                "[ ] 4. Future work",
            ]
        );
    }

    #[test]
    fn plan_lines_empty_for_empty_list() {
        assert!(render_todo_plan_lines(&[]).is_empty());
    }

    #[test]
    fn full_replacement_stores_and_emits() {
        let state = TodoState::default();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        state.subscribe(move |ev| sink.lock().unwrap().push(ev.clone()));

        let out = run_todo_write(
            vec![
                item("a", TodoStatus::Completed),
                item("b", TodoStatus::Pending),
            ],
            "s1",
            &state,
        );
        assert_eq!(out.status, OutcomeStatus::Executed);
        assert_eq!(out.output, "Todo list updated (1/2 done · next: b).");
        assert_eq!(out.meta.as_deref(), Some("1/2 done · next: b"));
        let ToolDisplay::Text { text } = out.display.unwrap() else {
            panic!("text display");
        };
        assert_eq!(text, "[x] 1. a\n[ ] 2. b");

        assert_eq!(state.todos("s1").len(), 2);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0].session_id, "s1");
        assert_eq!(seen.lock().unwrap()[0].todos.len(), 2);

        // Second call REPLACES (no delta merge).
        run_todo_write(vec![item("only", TodoStatus::InProgress)], "s1", &state);
        assert_eq!(
            state.todos("s1"),
            vec![item("only", TodoStatus::InProgress)]
        );
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn empty_todos_fail() {
        let state = TodoState::default();
        let out = run_todo_write(Vec::new(), "s1", &state);
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(out.output, "Missing or empty required arg: todos");
        assert!(state.todos("s1").is_empty());
    }

    #[test]
    fn multiple_in_progress_rejected() {
        let state = TodoState::default();
        let out = run_todo_write(
            vec![
                item("a", TodoStatus::InProgress),
                item("b", TodoStatus::InProgress),
            ],
            "s1",
            &state,
        );
        assert_eq!(out.status, OutcomeStatus::Failed);
        assert_eq!(
            out.output,
            "At most one todo can be in_progress at a time; got 2. Fix and retry."
        );
        assert!(state.todos("s1").is_empty());
    }

    #[test]
    fn missing_session_falls_back_to_default_bucket() {
        let state = TodoState::default();
        run_todo_write(vec![item("a", TodoStatus::Pending)], "", &state);
        assert_eq!(state.todos("default").len(), 1);
    }

    #[test]
    fn cancelled_counts_into_summary() {
        let state = TodoState::default();
        let out = run_todo_write(
            vec![
                item("a", TodoStatus::Completed),
                item("b", TodoStatus::Cancelled),
                item("c", TodoStatus::Pending),
            ],
            "s1",
            &state,
        );
        assert_eq!(
            out.meta.as_deref(),
            Some("1/3 done · 1 cancelled · next: c")
        );
    }

    #[test]
    fn clear_emits_empty_list() {
        let state = TodoState::default();
        run_todo_write(vec![item("a", TodoStatus::Pending)], "s1", &state);
        let seen = std::sync::Arc::new(Mutex::new(0));
        let sink = Arc::clone(&seen);
        state.subscribe(move |_| *sink.lock().unwrap() += 1);
        state.clear("s1");
        assert!(state.todos("s1").is_empty());
        assert_eq!(*seen.lock().unwrap(), 1);
    }

    #[test]
    fn unsubscribe_stops_delivery() {
        let state = TodoState::default();
        let seen = std::sync::Arc::new(Mutex::new(0));
        let sink = Arc::clone(&seen);
        let id = state.subscribe(move |_| *sink.lock().unwrap() += 1);
        state.set("s", vec![]);
        assert_eq!(*seen.lock().unwrap(), 1);
        state.unsubscribe(id);
        state.set("s", vec![]);
        assert_eq!(*seen.lock().unwrap(), 1);
    }

    #[test]
    fn execute_routes_through_trait_and_validates() {
        let tmp = tempfile::tempdir().unwrap();
        let tool = TodoWriteTool;
        assert_eq!(tool.spec().name, "todo_write");
        assert_eq!(tool.risk_tier(), RiskTier::ReadOnly);

        let ctx = ToolContext::new(tmp.path());
        let out = tool
            .execute(
                &ctx,
                json!({ "todos": [{ "content": "a", "status": "pending", "priority": "high" }] }),
            )
            .unwrap();
        assert_eq!(out.status, OutcomeStatus::Executed);
        // Empty session id stores under the "default" bucket (TS behavior).
        assert_eq!(ctx.todo_state.todos("default").len(), 1);
        assert_eq!(
            ctx.todo_state.todos("default")[0].priority,
            Some(TodoPriority::High)
        );

        let err = tool
            .execute(
                &ctx,
                json!({ "todos": [{ "content": "a", "status": "weird" }] }),
            )
            .unwrap_err();
        assert!(err.to_string().contains("invalid status"));

        let out = tool.execute(&ctx, json!({ "todos": [] })).unwrap();
        assert_eq!(out.status, OutcomeStatus::Failed);
    }

    #[test]
    fn todo_item_serializes_to_renderer_wire_shape() {
        let wire = serde_json::to_value(TodoItem {
            content: "a".into(),
            status: TodoStatus::InProgress,
            priority: None,
        })
        .unwrap();
        assert_eq!(wire, json!({ "content": "a", "status": "in_progress" }));

        let ev = serde_json::to_value(TodosUpdated {
            session_id: "s1".into(),
            todos: vec![item("a", TodoStatus::Pending)],
        })
        .unwrap();
        assert_eq!(ev["sessionId"], "s1");
        assert_eq!(ev["todos"][0]["status"], "pending");
    }
}
