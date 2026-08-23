/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/permissionCardPatterns.ts. Verbatim; no Tide-specific adaptation needed. */

export const getVisiblePermissionPatterns = (patterns: string[], renderedCommand: string): string[] => {
  if (!renderedCommand) return patterns;
  return patterns.filter((pattern) => pattern !== renderedCommand);
};
