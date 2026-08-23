/** Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/message/messageRole.ts.
 *  Pure role derivation — ported verbatim; `Message` becomes `OcMessage`. */

import type { OcMessage } from '../types/opencode-parts';

export interface MessageRoleInfo {
  role: string;
  isUser: boolean;
}

export const deriveMessageRole = (
  messageInfo: OcMessage | (OcMessage & { clientRole?: string; userMessageMarker?: boolean }),
): MessageRoleInfo => {
  const info = messageInfo as OcMessage & { clientRole?: string; userMessageMarker?: boolean; origin?: string; source?: string };
  const clientRole = info?.clientRole;
  const serverRole = info?.role;
  const userMarker = info?.userMessageMarker === true;

  const isUser =
    userMarker
    || clientRole === 'user'
    || serverRole === 'user'
    || info?.origin === 'user'
    || info?.source === 'user';

  if (isUser) {
    return {
      role: 'user',
      isUser: true,
    };
  }

  return {
    role: clientRole || serverRole || 'assistant',
    isUser: false,
  };
};
