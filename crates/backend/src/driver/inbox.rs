//! The tide driver's pending input, one queue per claim boundary (the shape
//! deepseek-harness calls its two-tier inbox): a prompt each deserves its
//! own turn, steering input rides the next step boundary of the running
//! turn. Replaces the ad-hoc steer-channel + prompt-queue pair with one
//! structure every input door flows through.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Who authored a step-boundary or turn input. The wake budget reads it at
/// the prompt-entry point: a `User` message refills the budget (the user is
/// back at the wheel); `Job` notices and `Agent` messages never do — they
/// are the loop's own output, and a self-refilling wake would unbound the
/// valve (design decision 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepSource {
    /// A user-authored prompt or steer.
    User,
    /// A background-job settlement notice (the wake's deliveries).
    Job,
    /// An agent-to-agent message (`send_message`).
    Agent,
}

impl StepSource {
    /// Whether consuming this message refills the wake budget.
    pub(crate) fn refills_budget(self) -> bool {
        matches!(self, StepSource::User)
    }
}

/// One claimed step-boundary input, with its sender when it arrived by
/// agent messaging (steering and injected context carry `None`).
/// `annotated` marks a parked message whose delivery the park path already
/// rendered on the recipient's timeline, so the resume drain does not
/// duplicate it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StepMessage {
    pub from: Option<String>,
    pub text: String,
    pub(crate) annotated: bool,
    pub source: StepSource,
}

impl StepMessage {
    /// A fresh, unannotated message — user-authored unless a tagged
    /// constructor says otherwise.
    fn new(from: Option<String>, text: String, source: StepSource) -> Self {
        Self {
            from,
            text,
            annotated: false,
            source,
        }
    }

    /// A user prompt or steer.
    pub fn user(text: String) -> Self {
        Self::new(None, text, StepSource::User)
    }

    /// A background-job settlement notice.
    pub fn job(text: String) -> Self {
        Self::new(None, text, StepSource::Job)
    }

    /// A message whose delivery is already visible on the timeline (the
    /// park path annotated it when it landed). Only the agent-messaging
    /// park path constructs these, so the source is `Agent`.
    pub fn parked(from: Option<String>, text: String) -> Self {
        Self {
            from,
            text,
            annotated: true,
            source: StepSource::Agent,
        }
    }
}

/// One step-boundary input. User steering promotes itself to the next
/// prompt when its turn ends before claiming it; tool-injected context must
/// never become a prompt, so it stays queued for the next step boundary.
struct StepInput {
    text: String,
    promotable: bool,
    from: Option<String>,
    source: StepSource,
}

impl StepInput {
    fn into_message(self) -> StepMessage {
        StepMessage::new(self.from, self.text, self.source)
    }
}

#[derive(Default)]
struct InboxState {
    next_turn: VecDeque<StepMessage>,
    next_step: VecDeque<StepInput>,
    /// Whether steering input can land. Open only while a turn runs; closed
    /// by the same lock that rescues leftovers at turn end, so a message can
    /// never strand in a turn that already stopped draining.
    steering_open: bool,
}

pub(crate) struct TurnInbox {
    state: Mutex<InboxState>,
}

impl TurnInbox {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(InboxState::default()),
        }
    }

    /// Queue an already-tagged message for the next turn boundary — the
    /// wake's lost-claim lane delivers notices here exactly like a prompt
    /// that landed mid-turn, source tag and all.
    pub fn push_turn_message(&self, message: StepMessage) {
        self.state.lock().unwrap().next_turn.push_back(message);
    }

    /// Open steering for a turn starting now (its step boundaries will
    /// claim queued input).
    pub fn open_steering(&self) {
        self.state.lock().unwrap().steering_open = true;
    }

    /// Queue steering input for the running turn's next step boundary.
    /// Returns `false` — without queueing — when no turn is steering, which
    /// the driver reports as a rejection.
    pub fn push_step(&self, message: String) -> bool {
        self.push_step_message(StepMessage::user(message))
    }

    /// Queue an already-tagged message for the running turn's next step
    /// boundary. Same steering-window rule as [`Self::push_step`].
    pub fn push_step_message(&self, message: StepMessage) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.steering_open {
            return false;
        }
        state.next_step.push_back(StepInput {
            text: message.text,
            promotable: true,
            from: message.from,
            source: message.source,
        });
        true
    }

    /// Queue an agent message for the running turn's next step boundary,
    /// tagged with its sender (`"main"` or a sibling agent name) so the
    /// recipient's timeline can annotate the delivery. Same steering-window
    /// rule as [`Self::push_step`].
    pub fn deliver(&self, from: &str, message: String) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.steering_open {
            return false;
        }
        state.next_step.push_back(StepInput {
            text: message,
            promotable: true,
            from: Some(from.to_owned()),
            source: StepSource::Agent,
        });
        true
    }

    /// Queue context for the next step boundary WITHOUT claiming a turn:
    /// it waits until a running turn's next step claims it and never
    /// promotes itself to a prompt. The door for tool-injected context
    /// (result follow-ups, compaction notices).
    pub fn inject(&self, context: String) {
        self.inject_message(StepMessage::user(context));
    }

    /// The tagged form of [`Self::inject`] — the wake's degrade lane queues
    /// a refused notice here when no turn is steering (idle, budget spent):
    /// it waits for whichever turn opens next and never claims one.
    pub fn inject_message(&self, message: StepMessage) {
        self.state.lock().unwrap().next_step.push_back(StepInput {
            text: message.text,
            promotable: false,
            from: message.from,
            source: message.source,
        });
    }

    /// Claim everything waiting for a step boundary, in arrival order.
    pub fn drain_step(&self) -> Vec<StepMessage> {
        let mut state = self.state.lock().unwrap();
        state
            .next_step
            .drain(..)
            .map(StepInput::into_message)
            .collect()
    }

    /// Claim the next prompt, if any.
    pub fn pop_turn(&self) -> Option<StepMessage> {
        self.state.lock().unwrap().next_turn.pop_front()
    }

    /// How many messages currently wait for a step boundary — the messaging
    /// cap reads this before delivering.
    pub fn step_depth(&self) -> usize {
        self.state.lock().unwrap().next_step.len()
    }

    /// Close steering and settle the turn's leftovers: steering the running
    /// turn never claimed promotes itself to the next prompt (it was a real
    /// user message), while injected context stays queued for whichever
    /// turn runs next.
    pub fn close_and_rescue(&self) {
        let mut state = self.state.lock().unwrap();
        state.steering_open = false;
        let mut remaining = VecDeque::new();
        while let Some(input) = state.next_step.pop_front() {
            if input.promotable {
                state.next_turn.push_back(input.into_message());
            } else {
                remaining.push_back(input);
            }
        }
        state.next_step = remaining;
    }

    /// Close steering and return whatever still waited for a step boundary,
    /// WITHOUT promoting anything — the caller parks it (a stopped child's
    /// mailbox delivers it on resume instead of promoting it to a prompt).
    pub fn close_and_return_step(&self) -> Vec<StepMessage> {
        let mut state = self.state.lock().unwrap();
        state.steering_open = false;
        state
            .next_step
            .drain(..)
            .map(StepInput::into_message)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(text: &str) -> StepMessage {
        StepMessage::user(text.to_owned())
    }

    #[test]
    fn turn_prompts_claim_in_order_and_step_input_waits_for_its_boundary() {
        let inbox = TurnInbox::new();
        inbox.push_turn("first".into());
        inbox.push_turn("second".into());
        assert_eq!(inbox.pop_turn().unwrap().text, "first");
        assert_eq!(inbox.pop_turn().unwrap().text, "second");
        assert_eq!(inbox.pop_turn(), None);
        // Step input never surfaces through the turn boundary.
        inbox.open_steering();
        assert!(inbox.push_step("steer".into()));
        assert_eq!(inbox.pop_turn(), None);
        assert_eq!(inbox.drain_step(), vec![step("steer")]);
    }

    #[test]
    fn step_input_rejected_while_no_turn_is_steering() {
        let inbox = TurnInbox::new();
        assert!(!inbox.push_step("too early".into()));
        inbox.open_steering();
        assert!(inbox.push_step("now".into()));
        assert_eq!(inbox.drain_step(), vec![step("now")]);
    }

    #[test]
    fn drain_step_claims_the_whole_batch_in_arrival_order() {
        let inbox = TurnInbox::new();
        inbox.open_steering();
        inbox.push_step("one".into());
        inbox.inject("context".into());
        inbox.push_step("two".into());
        assert_eq!(
            inbox.drain_step(),
            vec![step("one"), step("context"), step("two")]
        );
        assert!(inbox.drain_step().is_empty());
    }

    #[test]
    fn close_and_rescue_promotes_steering_but_not_injected_context() {
        let inbox = TurnInbox::new();
        inbox.open_steering();
        inbox.push_step("steer one".into());
        inbox.inject("quiet context".into());
        inbox.push_step("steer two".into());
        inbox.close_and_rescue();
        // Steering became prompts in arrival order; injected context stayed
        // queued for the next turn's step boundary.
        assert_eq!(inbox.pop_turn().unwrap().text, "steer one");
        assert_eq!(inbox.pop_turn().unwrap().text, "steer two");
        assert_eq!(inbox.pop_turn(), None);
        assert_eq!(inbox.drain_step(), vec![step("quiet context")]);
        // And steering is closed again.
        assert!(!inbox.push_step("late".into()));
    }

    #[test]
    fn rescue_then_reopen_keeps_surviving_across_turns() {
        let inbox = TurnInbox::new();
        inbox.open_steering();
        inbox.push_step("mid-turn".into());
        inbox.close_and_rescue();
        inbox.open_steering();
        assert_eq!(inbox.pop_turn().unwrap().text, "mid-turn");
        assert!(inbox.push_step("next turn's steer".into()));
        assert_eq!(inbox.drain_step(), vec![step("next turn's steer")]);
    }

    #[test]
    fn close_and_return_step_parks_without_promoting() {
        // A stopped child's leftover step input parks in its mailbox: it
        // comes back verbatim and NEVER becomes a prompt.
        let inbox = TurnInbox::new();
        inbox.open_steering();
        inbox.push_step("steer".into());
        inbox.inject("context".into());
        assert_eq!(inbox.step_depth(), 2);
        let parked = inbox.close_and_return_step();
        assert_eq!(parked, vec![step("steer"), step("context")]);
        assert_eq!(inbox.pop_turn(), None);
        assert!(inbox.drain_step().is_empty());
        // Steering is closed again.
        assert!(!inbox.push_step("late".into()));
    }

    #[test]
    fn delivered_messages_carry_their_sender() {
        // Agent messages deliver tagged with the sender so the recipient's
        // timeline can annotate them; steering and injected context stay
        // unattributed.
        let inbox = TurnInbox::new();
        inbox.open_steering();
        assert!(inbox.deliver("code-reviewer", "found it".into()));
        inbox.push_step("steer".into());
        assert_eq!(
            inbox.drain_step(),
            vec![
                StepMessage {
                    from: Some("code-reviewer".to_owned()),
                    text: "found it".to_owned(),
                    annotated: false,
                    source: StepSource::Agent,
                },
                step("steer"),
            ]
        );
    }

    #[test]
    fn parked_messages_mark_annotation_state() {
        // The park path's marker keeps the resume drain from duplicating a
        // delivery it already rendered on the timeline.
        let parked = StepMessage::parked(Some("main".to_owned()), "note".to_owned());
        assert!(parked.annotated);
        assert_eq!(parked.from.as_deref(), Some("main"));
        assert_eq!(parked.source, StepSource::Agent);
        // Fresh drains are never pre-annotated.
        let inbox = TurnInbox::new();
        inbox.open_steering();
        assert!(inbox.deliver("main", "live".into()));
        assert!(!inbox.drain_step()[0].annotated);
    }

    #[test]
    fn sources_travel_with_their_messages_for_the_budget() {
        // The wake budget reads the source at the prompt-entry point: user
        // pushes refill, job notices and agent messages never do. The tags
        // must survive every queue in the inbox.
        let inbox = TurnInbox::new();

        // Turn lane: user prompt vs a job notice pushed by the lost-claim
        // wake lane.
        inbox.push_turn("user prompt".into());
        inbox.push_turn_message(StepMessage::job("job notice".into()));
        assert_eq!(inbox.pop_turn().unwrap().source, StepSource::User);
        assert_eq!(inbox.pop_turn().unwrap().source, StepSource::Job);

        // Step lane: steering (User), delivered mail (Agent), an injected
        // notice pushed while steering is open (Job) — all promotable;
        // tags, not promotability, decide refills.
        inbox.open_steering();
        assert!(inbox.push_step("steer".into()));
        assert!(inbox.deliver("peer", "hello".into()));
        assert!(inbox.push_step_message(StepMessage::job("notice".into())));
        inbox.close_and_rescue();
        // All three promoted with their tags intact, in arrival order.
        assert_eq!(inbox.pop_turn().unwrap().source, StepSource::User);
        assert_eq!(inbox.pop_turn().unwrap().source, StepSource::Agent);
        assert_eq!(inbox.pop_turn().unwrap().source, StepSource::Job);
        // The degrade lane's always-open inject: a refused notice queued
        // while no turn is steering keeps its Job tag.
        inbox.inject_message(StepMessage::job("degraded notice".into()));
        assert_eq!(inbox.drain_step()[0].source, StepSource::Job);

        // Constructors: every existing door defaults to its honest tag.
        assert_eq!(StepMessage::user("p".into()).source, StepSource::User);
        assert_eq!(StepMessage::job("n".into()).source, StepSource::Job);
        assert_eq!(
            StepMessage::parked(None, "m".into()).source,
            StepSource::Agent
        );
        assert!(StepSource::User.refills_budget());
        assert!(!StepSource::Job.refills_budget());
        assert!(!StepSource::Agent.refills_budget());
    }
}
