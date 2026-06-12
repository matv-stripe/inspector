import { useState } from "react";
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

interface Message {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCall?: {
    name: string;
    args: object;
  };
}

type ChatTabProps = {
  chatURL: string;
  tools: Tool[];
  callTool: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<CompatibilityCallToolResult>;
};

const ChatTab = ({ chatURL, tools, callTool }: ChatTabProps) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSend = async () => {
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);

    try {
      const response = await fetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: userMessage, tools: tools || [] }),
      });

      if (!response.ok) {
        throw new Error("Failed to send message");
      }

      type LLMChatResponse = {
        response: string;
        toolCalls: Array<{ name: string; args: object }>;
      };
      const data: LLMChatResponse = await response.json();

      if (data.toolCalls && data.toolCalls.length > 0) {
        const toolCallResultPromises = data.toolCalls.map(async (tc) => {
          const toolCallResult = await callTool(
            tc.name,
            tc.args as Record<string, unknown>,
          );
          const toolResult = toolCallResult.content as any;
          if (toolResult[0].type !== "text") {
            throw new Error(
              "Unknown tool call result type: " + JSON.stringify(toolResult),
            );
          }
          return {
            role: "tool" as const,
            content: toolResult[0].text,
            toolCall: tc,
          };
        });
        const toolCallResults = await Promise.all(toolCallResultPromises);

        setMessages((prev) => [...prev, ...toolCallResults]);
      }

      if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Sorry, there was an error processing your message.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <TabsContent value="chat" className="h-full">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-3 ${
                  message.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : message.role === "tool"
                      ? "bg-secondary text-secondary-foreground"
                      : "bg-muted"
                }`}
              >
                {message.content}
                {message.toolCall && (
                  <div className="mt-2 text-sm">
                    <div className="font-medium">Tool:</div>
                    <pre className="mt-1 p-2 bg-background/50 rounded text-xs overflow-x-auto">
                      {message.toolCall.name}
                    </pre>
                    <div className="font-medium">Arguments:</div>
                    <pre className="mt-1 p-2 bg-background/50 rounded text-xs overflow-x-auto">
                      {JSON.stringify(message.toolCall.args, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
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
                      <Button variant="outline" size="icon" className="h-10">
                        <Hammer className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[300px]">
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
