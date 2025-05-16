#!/usr/bin/env node

import cors from "cors";
import { parseArgs } from "node:util";
import { parse as shellParseArgs } from "shell-quote";
import * as dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

import {
  SSEClientTransport,
  SseError,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import express from "express";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "./mcpProxy.js";
import OpenAI from "openai";

import { disableSocketProxy, enableSocketProxy } from "./socketProxy.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChatCompletionTool } from "openai/resources.mjs";
import { randomUUID } from "node:crypto";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];
const STREAMABLE_HTTP_HEADERS_PASSTHROUGH = [
  "authorization",
  "mcp-session-id",
  "last-event-id",
];

// We need this to work with local https for oauth
// process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(process.env.MCP_ENV_VARS ? JSON.parse(process.env.MCP_ENV_VARS) : {}),
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    env: { type: "string", default: "" },
    args: { type: "string", default: "" },
  },
});

const app = express();
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Expose-Headers", "mcp-session-id");
  next();
});

const webAppTransports: Map<string, Transport> = new Map<string, Transport>(); // Transports by sessionId

const createTransport = async (req: express.Request): Promise<Transport> => {
  const query = req.query;
  console.log("Query parameters:", query);

  const transportType = query.transportType as string;

  let url = query.url as string;
  console.log("Socket proxy path:", query.socketProxyPath);
  if (query.socketProxyPath) {
    enableSocketProxy(query.socketProxyPath as string);
    // This is because most socket proxys support http under the hood
    url = url.replace("https://", "http://");
  } else {
    disableSocketProxy();
  }

  if (transportType === "stdio") {
    const command = query.command as string;
    const origArgs = shellParseArgs(query.args as string) as string[];
    const queryEnv = query.env ? JSON.parse(query.env as string) : {};
    const env = { ...process.env, ...defaultEnvironment, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    console.log(`Stdio transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();

    console.log("Spawned stdio transport");
    return transport;
  } else if (transportType === "sse") {
    const headers: HeadersInit = {
      Accept: "text/event-stream",
    };

    for (const key of SSE_HEADERS_PASSTHROUGH) {
      if (req.headers[key] === undefined) {
        continue;
      }

      const value = req.headers[key];
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }

    console.log(`SSE transport: url=${url}, headers=${Object.keys(headers)}`);

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    await transport.start();

    console.log("Connected to SSE transport");
    return transport;
  } else if (transportType === "streamable-http") {
    const headers: HeadersInit = {
      Accept: "text/event-stream, application/json",
    };

    for (const key of STREAMABLE_HTTP_HEADERS_PASSTHROUGH) {
      if (req.headers[key] === undefined) {
        continue;
      }

      const value = req.headers[key];
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers,
      },
    });
    await transport.start();
    console.log("Connected to Streamable HTTP transport");
    return transport;
  } else {
    console.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

let backingServerTransport: Transport | undefined;

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  console.log(`Received GET message for sessionId ${sessionId}`);
  try {
    const transport = webAppTransports.get(
      sessionId,
    ) as StreamableHTTPServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    } else {
      await transport.handleRequest(req, res);
    }
  } catch (error) {
    console.error("Error in /mcp route:", error);
    res.status(500).json(error);
  }
});

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  console.log(`Received POST message for sessionId ${sessionId}`);
  if (!sessionId) {
    try {
      console.log("New streamable-http connection");
      try {
        await backingServerTransport?.close();
        backingServerTransport = await createTransport(req);
      } catch (error) {
        if (error instanceof SseError && error.code === 401) {
          console.error(
            "Received 401 Unauthorized from MCP server:",
            error.message,
          );
          res.status(401).json(error);
          return;
        }

        throw error;
      }

      console.log("Connected MCP client to backing server transport");

      const webAppTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          webAppTransports.set(sessionId, webAppTransport);
          console.log("Created streamable web app transport " + sessionId);
        },
      });

      await webAppTransport.start();

      mcpProxy({
        transportToClient: webAppTransport,
        transportToServer: backingServerTransport,
      });

      await (webAppTransport as StreamableHTTPServerTransport).handleRequest(
        req,
        res,
        req.body,
      );
    } catch (error) {
      console.error("Error in /mcp POST route:", error);
      res.status(500).json(error);
    }
  } else {
    try {
      const transport = webAppTransports.get(
        sessionId,
      ) as StreamableHTTPServerTransport;
      if (!transport) {
        res.status(404).end("Transport not found for sessionId " + sessionId);
      } else {
        await (transport as StreamableHTTPServerTransport).handleRequest(
          req,
          res,
        );
      }
    } catch (error) {
      console.error("Error in /mcp route:", error);
      res.status(500).json(error);
    }
  }
});

app.get("/stdio", async (req, res) => {
  try {
    console.log("New connection");

    try {
      await backingServerTransport?.close();
      backingServerTransport = await createTransport(req);
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server:",
          error.message,
        );
        res.status(401).json(error);
        return;
      }

      throw error;
    }

    console.log("Connected MCP client to backing server transport");

    const webAppTransport = new SSEServerTransport("/message", res);
    webAppTransports.set(webAppTransport.sessionId, webAppTransport);

    console.log("Created web app transport");

    await webAppTransport.start();
    (backingServerTransport as StdioClientTransport).stderr!.on(
      "data",
      (chunk) => {
        webAppTransport.send({
          jsonrpc: "2.0",
          method: "notifications/stderr",
          params: {
            content: chunk.toString(),
          },
        });
      },
    );

    mcpProxy({
      transportToClient: webAppTransport,
      transportToServer: backingServerTransport,
    });

    console.log("Set up MCP proxy");
  } catch (error) {
    console.error("Error in /stdio route:", error);
    res.status(500).json(error);
  }
});

app.get("/sse", async (req, res) => {
  try {
    console.log(
      "New SSE connection. NOTE: The sse transport is deprecated and has been replaced by streamable-http",
    );

    try {
      await backingServerTransport?.close();
      backingServerTransport = await createTransport(req);
    } catch (error) {
      if (error instanceof SseError && error.code === 401) {
        console.error(
          "Received 401 Unauthorized from MCP server:",
          error.message,
        );
        res.status(401).json(error);
        return;
      }

      throw error;
    }

    console.log("Connected MCP client to backing server transport");

    const webAppTransport = new SSEServerTransport("/message", res);
    webAppTransports.set(webAppTransport.sessionId, webAppTransport);
    console.log("Created web app transport");

    await webAppTransport.start();

    mcpProxy({
      transportToClient: webAppTransport,
      transportToServer: backingServerTransport,
    });

    console.log("Set up MCP proxy");
  } catch (error) {
    console.error("Error in /sse route:", error);
    res.status(500).json(error);
  }
});

app.post("/message", async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    console.log(`Received message for sessionId ${sessionId}`);

    const transport = webAppTransports.get(
      sessionId as string,
    ) as SSEServerTransport;
    if (!transport) {
      res.status(404).end("Session not found");
      return;
    }
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error in /message route:", error);
    res.status(500).json(error);
  }
});

const openai = new OpenAI({
  baseURL: `${process.env.HTTP_PROXY}/v1/`,
  apiKey: process.env.OPEN_AI_KEY,
  defaultHeaders: {
    Host: process.env.OPEN_AI_HOST,
  },
});

app.post("/chat", express.json(), async (req, res) => {
  try {
    const { message } = req.body;
    const tools: Tool[] = req.body.tools;
    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const openAITools: ChatCompletionTool[] = tools.flatMap((tool) => {
      if (!tool.name || !tool.description || !tool.inputSchema) {
        return [];
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      };
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: message }],
      tools: openAITools,
    });

    const responseMessage = completion.choices[0].message;

    const toolsCalled = responseMessage.tool_calls?.map((tc) => {
      return {
        name: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      };
    });

    res.json({
      response: responseMessage.content,
      toolCalls: toolsCalled,
    });
  } catch (error) {
    console.error("Error in /chat route:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.get("/config", (req, res) => {
  try {
    res.json({
      defaultEnvironment,
      defaultCommand: values.env,
      defaultArgs: values.args,
    });
  } catch (error) {
    console.error("Error in /config route:", error);
    res.status(500).json(error);
  }
});

const PORT = process.env.PORT || 6277;

const server = app.listen(PORT);
server.on("listening", () => {
  console.log(`⚙️ Proxy server listening on port ${PORT}`);
});
server.on("error", (err) => {
  if (err.message.includes(`EADDRINUSE`)) {
    console.error(`❌  Proxy Server PORT IS IN USE at port ${PORT} ❌ `);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});
