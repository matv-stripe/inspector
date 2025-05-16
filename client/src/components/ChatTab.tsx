import { useState, useEffect } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Send, Hammer } from "lucide-react";
import {
  CompatibilityCallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { executeAgenticLoop } from "@/utils/executeAgenticLoop";
import {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import JsonView from "./JsonView";

type ChatTabProps = {
  chatURL: string;
  tools: Tool[];
  callTool: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<CompatibilityCallToolResult>;
  listTools: () => void;
};

const MessageBubble = ({
  message,
}: {
  message: ChatCompletionMessageParam;
}) => {
  let content = "";

  if (message.role === "tool") {
    content = JSON.parse(message.content as string)[0].text;
  } else if (typeof message.content === "string") {
    content = message.content;
  } else if (message.content && typeof message.content === "object") {
    content = JSON.stringify(message.content, null, 2);
  }

  let toolCalls: ChatCompletionMessageToolCall[] = [];

  if ("tool_calls" in message && message.tool_calls) {
    toolCalls = message.tool_calls;
  }

  return (
    <div
      className={`max-w-[80%] rounded-lg p-3 ${
        message.role === "user"
          ? "bg-primary text-primary-foreground"
          : message.role === "tool"
            ? "bg-secondary text-secondary-foreground"
            : "bg-muted"
      }`}
    >
      {message.role === "tool" ? (
        <JsonView className="text-xs" data={content} />
      ) : (
        content
      )}
      {toolCalls.map((toolCall, index) => (
        <div key={toolCall.id + "" + index} className="mt-2">
          <div className="text-sm text-muted-foreground">
            Tool Call: {toolCall.function.name}
          </div>
          <pre className="text-xs bg-secondary p-2 rounded">
            {JSON.stringify(toolCall.function.arguments, null, 2)}
          </pre>
        </div>
      )) ?? null}
    </div>
  );
};

const ChatTab = ({ chatURL, tools, listTools, callTool }: ChatTabProps) => {
  const [messages, setMessages] = useState<ChatCompletionMessageParam[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (tools.length === 0) {
      listTools();
    }
  }, [tools, listTools]);

  const handleSend = async () => {
    if (!input.trim()) return;

    const initialMessages: ChatCompletionMessageParam[] = [
      ...messages,
      { role: "user", content: input.trim() } as ChatCompletionMessageParam,
    ];
    setInput("");
    setMessages(initialMessages);
    setIsLoading(true);

    await executeAgenticLoop({
      chatAPIEndpoint: chatURL,
      initialMessages,
      tools: tools,
      onUpdateMessages: setMessages,
      callTool,
    });

    setIsLoading(false);
  };

  return (
    <TabsContent value="chat" className="h-96">
      <div className="flex flex-col h-[900px]">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <MessageBubble message={message} />
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg p-3">
                <Loader2 className="w-4 h-4 animate-spin" />
              </div>
            </div>
          )}
        </div>
        <div className="border-t p-4 bg-background">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message..."
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="flex gap-2">
              {tools.length > 0 && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-10 relative"
                      >
                        <Hammer className="w-4 h-4" />
                        <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground text-xs rounded-full h-4 w-4 flex items-center justify-center">
                          {tools.length}
                        </span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[900px]">
                      <div className="space-y-2">
                        <p className="font-medium">Available Tools:</p>
                        <ul className="list-disc list-inside space-y-1">
                          {tools.map((tool, index) => (
                            <li key={index} className="text-sm">
                              <span className="font-medium">{tool.name}</span>
                              {tool.description && (
                                <span className="text-muted-foreground">
                                  {" - "}
                                  {tool.description}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <Button onClick={handleSend} disabled={isLoading}>
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </TabsContent>
  );
};

export default ChatTab;
