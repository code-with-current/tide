/**
 * Ported from openchamber/openchamber (MIT): packages/ui/src/components/chat/ChatErrorBoundary.tsx — RECIPE PORT.
 * OpenChamber port seams: i18n (`useI18n`) → the upstream English strings
 * inlined; `../ui/button` + `../ui/card` → Tide's shadcn primitives
 * (`@/components/ui/*`); upstream's `Icon` → the ported lucide shim
 * (`chat-3`/`restart` names added there for this file).
 */

import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Icon } from './icon';

interface ChatErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

interface ChatErrorBoundaryProps {
  children: React.ReactNode;
  sessionId?: string;
}

interface ChatErrorBoundaryTexts {
  title: string;
  description: string;
  sessionLabel: string;
  detailsSummary: string;
  resetAction: string;
  persistentHint: string;
}

interface ChatErrorBoundaryViewProps extends ChatErrorBoundaryProps {
  texts: ChatErrorBoundaryTexts;
}

class ChatErrorBoundaryView extends React.Component<ChatErrorBoundaryViewProps, ChatErrorBoundaryState> {
  constructor(props: ChatErrorBoundaryViewProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo });

    if (process.env.NODE_ENV === 'development') {
      console.error('Chat error caught by boundary:', error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <CardTitle className="flex items-center justify-center gap-2 text-destructive">
                <Icon name="chat-3" className="h-5 w-5" />
                {this.props.texts.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {this.props.texts.description}
              </p>

              {this.props.sessionId && (
                <div className="text-xs text-muted-foreground text-center">
                  {this.props.texts.sessionLabel}: {this.props.sessionId}
                </div>
              )}

              {this.state.error && (
                <details className="text-xs font-mono bg-muted p-3 rounded">
                  <summary className="cursor-pointer hover:bg-interactive-hover/80">{this.props.texts.detailsSummary}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto">
                    {this.state.error.toString()}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset} variant="outline" className="flex-1">
                  <Icon name="restart" className="h-4 w-4 mr-2" />
                  {this.props.texts.resetAction}
                </Button>
              </div>

              <div className="text-xs text-muted-foreground text-center">
                {this.props.texts.persistentHint}
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

const CHAT_ERROR_BOUNDARY_TEXTS: ChatErrorBoundaryTexts = {
  title: 'Something went wrong',
  description: 'The chat view hit an unexpected error. The rest of the app is still running.',
  sessionLabel: 'Session',
  detailsSummary: 'Error details',
  resetAction: 'Reset chat view',
  persistentHint: 'If this keeps happening, restart the app.',
};

export function ChatErrorBoundary(props: ChatErrorBoundaryProps) {
  return <ChatErrorBoundaryView {...props} texts={CHAT_ERROR_BOUNDARY_TEXTS} />;
}
