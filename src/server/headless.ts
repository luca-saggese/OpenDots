import { IntelligenceAgent } from '@copilotkit/core';
import type { BaseEvent, Message } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

function completedTurnText(
  messages: Message[],
  error?: Error,
): string | undefined {
  if (error) throw error;
  const assistant = messages
    .filter((message) => message.role === 'assistant')
    .at(-1);
  const content = assistant?.content;
  const resolvedToolCalls = new Set(
    messages.flatMap((message) =>
      message.role === 'tool' ? [message.toolCallId] : [],
    ),
  );
  const pendingToolCall =
    assistant?.role === 'assistant' &&
    assistant.toolCalls?.some((call) => !resolvedToolCalls.has(call.id));
  if (pendingToolCall) return undefined;
  return typeof content === 'string' && content.trim() ? content : undefined;
}

const runtimeInfoSchema = z.object({
  mode: z.literal('intelligence'),
  intelligence: z.object({ wsUrl: z.url() }),
  agents: z.record(z.string(), z.unknown()),
});

export async function runThreadTurn(
  runtimeUrl: string,
  headers: Record<string, string>,
  dotId: string,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
  runId?: string,
  onEvent?: (event: BaseEvent) => void,
): Promise<string> {
  signal.throwIfAborted();
  const response = await fetch(`${runtimeUrl}/info`, { headers, signal });
  if (!response.ok)
    throw new Error(`Intelligence runtime returned HTTP ${response.status}.`);
  const info = runtimeInfoSchema.parse(await response.json());
  if (!Object.hasOwn(info.agents, dotId))
    throw new Error('The selected Dot is unavailable in the runtime.');
  // Core's runtime discovery is browser-only. Use the SDK's Node-compatible
  // Intelligence agent for voice compute and scheduled server turns.
  const agent = new IntelligenceAgent({
    url: info.intelligence.wsUrl,
    runtimeUrl,
    agentId: dotId,
    headers,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  });
  agent.threadId = threadId;
  let runError: Error | undefined;
  const subscription = agent.subscribe({
    onEvent: ({ event }) => onEvent?.(event),
    onRunErrorEvent: ({ event }) => {
      runError = new Error(event.message);
    },
  });
  const stop = () => agent.abortRun();
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    const idPrefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : '';
    agent.addMessage({
      id: `${idPrefix}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    });
    let result = await agent.runAgent(runId ? { runId } : undefined);
    while (true) {
      signal.throwIfAborted();
      const answer = completedTurnText(result.newMessages, runError);
      if (answer) return answer;
      agent.addMessage({
        id: randomUUID(),
        role: 'user',
        content:
          'Continue from all tool results already present. Resolve every pending tool call, call any additional tools needed for the task, and keep going until no tool call remains pending. Then write a concise user-facing final answer.',
      });
      runError = undefined;
      result = await agent.runAgent();
    }
  } finally {
    signal.removeEventListener('abort', stop);
    subscription.unsubscribe();
    await agent.detachActiveRun();
  }
}
