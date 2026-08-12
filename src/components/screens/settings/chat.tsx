import { Segmented } from '@/components/ui/segmented';
import { useUi } from '@/lib/stores/ui';
import { Card, SettingsGroup, SettingsHeader, SettingsRow } from './shared';

export function ChatSection() {
  const reasoningView = useUi((s) => s.reasoningView);
  const setReasoningView = useUi((s) => s.setReasoningView);
  const chatView = useUi((s) => s.chatView);
  const setChatView = useUi((s) => s.setChatView);

  return (
    <>
      <SettingsHeader
        title="Chat"
        description="Control how messages and model reasoning render in the conversation stream."
      />

      <SettingsGroup title="Layout">
        <Card>
          <SettingsRow
            title="Turn view"
            description="Compact groups thinking and process into collapsible sections. Stream shows every block inline in the order it was emitted."
            last
          >
            <Segmented
              size="sm"
              value={chatView}
              onChange={setChatView}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'stream', label: 'Stream' },
              ]}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>

      <SettingsGroup title="Reasoning">
        <Card>
          <SettingsRow
            title="Thinking view"
            description="Flat shows reasoning as one collapsible block. Phased groups it into Planning → Search → Coding → Verifying segments."
            last
          >
            <Segmented
              size="sm"
              value={reasoningView}
              onChange={setReasoningView}
              options={[
                { value: 'flat', label: 'Flat' },
                { value: 'phased', label: 'Phased' },
              ]}
            />
          </SettingsRow>
        </Card>
      </SettingsGroup>
    </>
  );
}
