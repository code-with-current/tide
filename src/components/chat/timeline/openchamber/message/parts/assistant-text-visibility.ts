/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/parts/assistantTextVisibility.ts.
 *  Pure predicates — ported verbatim (re-indented 4-space to 2-space). */

export const resolveAssistantDisplayText = (input: {
  textContent: string;
  throttledTextContent: string;
  isStreaming: boolean;
}): string => {
  return input.isStreaming ? input.throttledTextContent : input.textContent;
};

export const shouldRenderAssistantText = (input: {
  displayTextContent: string;
  isFinalized: boolean;
}): boolean => {
  if (!input.isFinalized && input.displayTextContent.trim().length === 0) {
    return false;
  }
  return input.displayTextContent.trim().length > 0;
};
