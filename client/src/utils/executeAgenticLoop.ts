/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-await-in-loop */
import {
  CompatibilityCallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ChatCompletionMessageParam,
  ChatCompletionMessage,
} from "openai/resources/chat/completions";

type Args = {
  /** The endpoint to send the chat request to */
  chatAPIEndpoint: string;

  /** The initial messages in the conversation */
  initialMessages: ChatCompletionMessageParam[];
  /** The list of tools available to the agent */
  tools: ListToolsResult["tools"];
  /**
   * Callback to fire when a new message is added to the conversation; will
   * include ALL messages not just new ones.
   */
  onUpdateMessages: (messages: ChatCompletionMessageParam[]) => void;

  /** The function to call to call a tool */
  callTool: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<CompatibilityCallToolResult>;

  /** The maximum number of loops to execute. Default is 10. */
  maxLoops?: number;
};

/**
 * Executes a loop of LLM calls where the LLM is offered a list of tools to use
 * and can call them as needed.
 */
export async function executeAgenticLoop({
  chatAPIEndpoint,
  initialMessages,
  tools,
  onUpdateMessages,
  callTool,
  maxLoops = 10,
}: Args) {
  let responseComplete = false;
  let numLoops = 0;

  const newMessages: ChatCompletionMessageParam[] = [];

  while (!responseComplete && numLoops < maxLoops) {
    numLoops += 1;
    const currentMessages = [...initialMessages, ...newMessages];

    const chatResponse = await fetch(chatAPIEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({
        messages: currentMessages,
        tools: tools,
      }),
    });

    const data = await chatResponse.json();

    const firstMessage: ChatCompletionMessage = data.message;
    newMessages.push(firstMessage);
    onUpdateMessages([...initialMessages, ...newMessages]);

    const { tool_calls: toolCalls } = firstMessage;

    if (toolCalls && toolCalls.length > 0) {
      // Process all tool calls in parallel
      await Promise.all(
        toolCalls.map(async (toolCall) => {
          const functionCall = toolCall.function;

          const toolCallResponse = (await callTool(
            functionCall.name,
            JSON.parse(functionCall.arguments),
          )) as CompatibilityCallToolResult;

          newMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolCallResponse?.content),
          });
        }),
      );

      onUpdateMessages([...initialMessages, ...newMessages]);
    } else {
      responseComplete = true;
    }
  }
}
