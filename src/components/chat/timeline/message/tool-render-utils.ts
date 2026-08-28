// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['read', 'skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getToolDescriptionFallback = (
    toolName: unknown,
    description: unknown,
    input: Record<string, unknown> | undefined,
): string => {
    if (typeof description === 'string' && description.trim().length > 0) {
        return description;
    }

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};

// NEW Tide seam (not upstream): the Tide adapter passes ToolCallStatus through
// unmapped and its parts carry no per-part timestamps, so tool finality must be
// the Tide status vocabulary — upstream's state.time.end check would hide every
// finished tool row. 'awaiting_input' (permission pause) stays active.
const ACTIVE_TOOL_STATUSES = new Set(['pending', 'running', 'awaiting_input']);
const FINALIZED_TOOL_STATUSES = new Set(['executed', 'failed', 'rejected', 'timeout', 'aborted', 'partial']);

export const isActiveToolStatus = (status: unknown): boolean => {
    return typeof status === 'string' && ACTIVE_TOOL_STATUSES.has(status);
};

export const isFinalizedToolStatus = (status: unknown): boolean => {
    return typeof status === 'string' && FINALIZED_TOOL_STATUSES.has(status);
};
