/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/lib/turns/constants.ts. Tide adaptation: 'dispatch_agent' is Tide's subagent tool (OpenCode's equivalent is 'task'), so it joins the standalone-activity set. */

export const ACTIVITY_STANDALONE_TOOL_NAMES = new Set<string>(['task', 'dispatch_agent']);
