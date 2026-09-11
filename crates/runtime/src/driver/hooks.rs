//! The tide driver's ordered extension seams — a Rust-sized port of dsh's
//! waterfall idea, kept to the two points that already had hardcoded
//! logic: gating a tool call, and rewriting step-boundary input. No
//! generic middleware framework: two trait chains, run in order.

use std::sync::Arc;

use serde_json::Value;

use super::inbox::StepMessage;
use crate::model::InteractionMode;

/// One model-issued tool call as the gates see it — borrowed views of the
/// pending call, since gates only read.
pub(crate) struct PendingToolCall<'a> {
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub arguments: &'a Value,
}

/// One link in the tool gate chain. `Err(reason)` rejects the call with a
/// model-facing reason; the first rejection wins and later gates do not
/// run. The Plan/Build chip is the first (and currently only) link — see
/// tide.rs's `PlanModeGate`.
pub(crate) trait ToolGate: Send + Sync {
    fn check(&self, call: PendingToolCall<'_>, mode: InteractionMode) -> Result<(), String>;
}

/// Ordered tool gates. The chain's `check` is the single consult point the
/// executor calls before running any tool.
#[derive(Default)]
pub(crate) struct HookChain {
    gates: Vec<Arc<dyn ToolGate>>,
}

impl HookChain {
    pub fn new(gates: Vec<Arc<dyn ToolGate>>) -> Self {
        Self { gates }
    }

    /// Run every gate in order; the first rejection is the outcome and
    /// later gates do not run.
    pub fn check(&self, call: PendingToolCall<'_>, mode: InteractionMode) -> Result<(), String> {
        for gate in &self.gates {
            gate.check(
                PendingToolCall {
                    tool_call_id: call.tool_call_id,
                    tool_name: call.tool_name,
                    arguments: call.arguments,
                },
                mode,
            )?;
        }
        Ok(())
    }
}

/// Rewrites the claimed step-boundary input (steering plus injected
/// context) before it enters history. The attachment point for future
/// compaction notices and tool-injected context; identity by default.
/// Senders ride along untouched — rewrites shape text, not provenance.
pub(crate) trait StepInputHook: Send + Sync {
    fn rewrite(&self, messages: Vec<StepMessage>) -> Vec<StepMessage> {
        messages
    }
}

/// Ordered step-input rewrites applied in sequence.
#[derive(Default)]
pub(crate) struct StepInputChain {
    hooks: Vec<Arc<dyn StepInputHook>>,
}

impl StepInputChain {
    pub fn new(hooks: Vec<Arc<dyn StepInputHook>>) -> Self {
        Self { hooks }
    }

    pub fn rewrite(&self, mut messages: Vec<StepMessage>) -> Vec<StepMessage> {
        for hook in &self.hooks {
            messages = hook.rewrite(messages);
        }
        messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct AllowGate;
    impl ToolGate for AllowGate {
        fn check(&self, _call: PendingToolCall<'_>, _mode: InteractionMode) -> Result<(), String> {
            Ok(())
        }
    }

    /// Rejects everything with a fixed reason, recording that it ran.
    struct RejectGate<'a> {
        reason: &'a str,
        ran: std::sync::atomic::AtomicBool,
    }

    impl ToolGate for RejectGate<'_> {
        fn check(&self, _call: PendingToolCall<'_>, _mode: InteractionMode) -> Result<(), String> {
            self.ran.store(true, std::sync::atomic::Ordering::SeqCst);
            Err(self.reason.to_owned())
        }
    }

    fn sample_call() -> (String, String, Value) {
        ("c1".to_owned(), "bash".to_owned(), serde_json::json!({}))
    }

    #[test]
    fn empty_chain_allows_everything() {
        let chain = HookChain::default();
        let (id, name, args) = sample_call();
        assert!(
            chain
                .check(
                    PendingToolCall {
                        tool_call_id: &id,
                        tool_name: &name,
                        arguments: &args,
                    },
                    InteractionMode::Build,
                )
                .is_ok()
        );
    }

    #[test]
    fn chain_short_circuits_on_the_first_rejection() {
        let reject: Arc<dyn ToolGate> = Arc::new(RejectGate {
            reason: "blocked by test",
            ran: std::sync::atomic::AtomicBool::new(false),
        });
        let after = Arc::new(RejectGate {
            reason: "never reached",
            ran: std::sync::atomic::AtomicBool::new(false),
        });
        let after_gate: Arc<dyn ToolGate> = after.clone();
        let chain = HookChain::new(vec![Arc::new(AllowGate), reject, after_gate]);
        let (id, name, args) = sample_call();
        let verdict = chain.check(
            PendingToolCall {
                tool_call_id: &id,
                tool_name: &name,
                arguments: &args,
            },
            InteractionMode::Plan,
        );
        assert_eq!(verdict.unwrap_err(), "blocked by test");
        // The gate after the rejection never ran.
        assert!(!after.ran.load(std::sync::atomic::Ordering::SeqCst));
    }

    struct TagHook(&'static str);
    impl StepInputHook for TagHook {
        fn rewrite(&self, mut messages: Vec<StepMessage>) -> Vec<StepMessage> {
            for message in &mut messages {
                message.text.push_str(self.0);
            }
            messages
        }
    }

    fn msg(text: &str) -> StepMessage {
        StepMessage {
            from: None,
            text: text.to_owned(),
            annotated: false,
            source: crate::driver::inbox::StepSource::User,
        }
    }

    #[test]
    fn step_input_chain_is_identity_without_hooks_and_ordered_with_them() {
        let plain = StepInputChain::default();
        assert_eq!(
            plain.rewrite(vec![msg("a"), msg("b")]),
            vec![msg("a"), msg("b")]
        );
        let tagged = StepInputChain::new(vec![Arc::new(TagHook("1")), Arc::new(TagHook("2"))]);
        assert_eq!(
            tagged.rewrite(vec![msg("a")]),
            vec![msg("a12")],
            "hooks apply left to right"
        );
    }
}
