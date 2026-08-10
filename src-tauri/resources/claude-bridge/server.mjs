#!/usr/bin/env node
/**
 * Claude Code bridge for Pluely.
 *
 * Exposes an OpenAI-compatible /v1/chat/completions endpoint backed by the
 * `claude` CLI in headless mode. Pluely talks to it as a plain custom provider,
 * so nothing in the chat engine needs to know Claude Code exists.
 *
 *   Pluely webview --HTTP/SSE--> this server --stdin/stdout--> claude
 *
 * No npm dependencies: run it with `node server.mjs`.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PLUELY_BRIDGE_PORT) || 8787;
const HOST = "127.0.0.1";
const CLAUDE_BIN = process.env.PLUELY_CLAUDE_BIN || "claude";
const DEFAULT_MODEL = process.env.PLUELY_CLAUDE_MODEL || "sonnet";
const REQUEST_TIMEOUT_MS = Number(process.env.PLUELY_BRIDGE_TIMEOUT_MS) || 300_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // screenshots arrive as base64

// Claude Code registers these regardless of flags; denying them keeps the
// assistant to pure Q&A with no side effects on the user's machine.
const DISALLOWED_TOOLS = [
  "Task", "Artifact", "Bash", "CronCreate", "CronDelete", "CronList",
  "DesignSync", "Edit", "EnterWorktree", "ExitWorktree", "ListAgents",
  "Monitor", "NotebookEdit", "PushNotification", "Read", "RemoteTrigger",
  "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill", "TaskOutput",
  "TaskStop", "TodoWrite", "ToolSearch", "WebFetch", "WebSearch", "Write",
].join(",");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const log = (...args) => console.log(`[bridge ${new Date().toISOString()}]`, ...args);

/* ------------------------------------------------------------------ *
 * OpenAI request -> Claude Code invocation
 * ------------------------------------------------------------------ */

/** Flattens an OpenAI `content` value (string or block array) to plain text. */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Splits a data URL into the pieces Claude's image block needs.
 * Tolerates a bare base64 payload, which is what Pluely's {{IMAGE}} holds
 * before the provider template wraps it.
 */
function parseImageUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) return { mediaType: match[1], data: match[2] };
  if (/^[A-Za-z0-9+/=\s]+$/.test(url)) {
    return { mediaType: "image/png", data: url.replace(/\s/g, "") };
  }
  return null; // remote URLs are not supported by the CLI's stdin protocol
}

/** Collects every image block from an OpenAI message. */
function extractImages(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const block of content) {
    if (block?.type !== "image_url") continue;
    const raw = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
    const parsed = parseImageUrl(raw);
    if (parsed) images.push(parsed);
    else log("skipping unsupported image_url (remote URLs are not supported)");
  }
  return images;
}

/**
 * Turns an OpenAI messages array into the three things the CLI needs:
 * a system prompt, a stdin payload for the current turn, and nothing else.
 *
 * Prior turns are flattened into the current prompt rather than replayed as
 * separate events: Pluely resends the whole history on every request and has
 * no stable conversation id, so a stateless render is the honest mapping.
 */
function buildInvocation(messages) {
  const systemParts = [];
  const history = [];
  let current = null;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      const text = contentToText(message.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      history.push(message);
    }
  }

  // The last user message is the actual question; everything before is context.
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      current = history.splice(i, 1)[0];
      break;
    }
  }
  if (!current) throw new Error("no user message in request");

  const question = contentToText(current.content).trim();
  const images = extractImages(current.content);

  let prompt = question;
  if (history.length > 0) {
    const transcript = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${contentToText(m.content).trim()}`)
      .filter((line) => line.length > "Assistant: ".length)
      .join("\n\n");
    if (transcript) {
      prompt = `Previous conversation:\n\n${transcript}\n\n---\n\nCurrent question: ${question}`;
    }
  }

  const blocks = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.data },
  }));
  blocks.push({ type: "text", text: prompt || "(no question provided)" });

  return {
    system: systemParts.join("\n\n"),
    stdin: JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n",
    imageCount: images.length,
  };
}

/** Model names reach argv, so reject anything that isn't a plain identifier. */
function safeModel(model) {
  return typeof model === "string" && /^[A-Za-z0-9._-]+$/.test(model) ? model : DEFAULT_MODEL;
}

/**
 * Spawns `claude` for one turn.
 *
 * Every variable-length value (system prompt, question, images) travels via a
 * file or stdin, never argv — that keeps the command line free of quotes,
 * newlines and cmd.exe metacharacters, which is what makes `shell: true` safe
 * on Windows where npm installs `claude` as a .cmd shim.
 */
function spawnClaude({ system, stdin, model }) {
  const dir = mkdtempSync(join(tmpdir(), "pluely-bridge-"));
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  // The MCP config goes through a file rather than inline JSON: cmd.exe strips
  // the quotes from `{"mcpServers":{}}`, and Claude then reads the mangled
  // `{mcpServers:{}}` as a (missing) file path.
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, '{"mcpServers":{}}', "utf8");

  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    "--strict-mcp-config",
    "--mcp-config", mcpFile,
    "--disallowed-tools", DISALLOWED_TOOLS,
  ];

  if (system) {
    const systemFile = join(dir, "system.txt");
    writeFileSync(systemFile, system, "utf8");
    args.push("--system-prompt-file", systemFile);
  }

  const child = spawn(CLAUDE_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });

  child.once("close", cleanup);
  child.once("error", cleanup);

  child.stdin.on("error", () => {}); // child may exit before we finish writing
  child.stdin.write(stdin);
  child.stdin.end();

  return child;
}

/* ------------------------------------------------------------------ *
 * Claude stream-json -> OpenAI deltas
 * ------------------------------------------------------------------ */

/**
 * Reads the CLI's JSONL stdout and reports only user-visible assistant text.
 *
 * Thinking and text arrive as separate content blocks on the same stream, so
 * block types are tracked by index and only `text` blocks are forwarded —
 * otherwise the model's reasoning would be rendered as the answer.
 */
function consumeClaudeStream(child, { onText, onError, onDone }) {
  const textBlocks = new Set();
  let buffer = "";
  let finished = false;

  const finish = (errorMessage) => {
    if (finished) return;
    finished = true;
    if (errorMessage) onError(errorMessage);
    onDone();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    // A single JSON object can span several chunks; only parse complete lines.
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // non-JSON diagnostics on stdout
      }

      if (event.type === "stream_event") {
        const inner = event.event;
        if (inner?.type === "content_block_start") {
          if (inner.content_block?.type === "text") textBlocks.add(inner.index);
        } else if (inner?.type === "content_block_delta") {
          if (inner.delta?.type === "text_delta" && textBlocks.has(inner.index)) {
            onText(inner.delta.text);
          }
        }
        continue;
      }

      if (event.type === "result") {
        if (event.is_error) {
          finish(typeof event.result === "string" && event.result
            ? event.result
            : `Claude Code error (${event.subtype || "unknown"})`);
        } else {
          finish(null);
        }
      }
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  child.on("error", (err) => {
    finish(
      err.code === "ENOENT"
        ? `Claude Code CLI not found (tried "${CLAUDE_BIN}"). Install it with: npm install -g @anthropic-ai/claude-code`
        : `Failed to start Claude Code: ${err.message}`
    );
  });

  child.on("close", (code) => {
    // A clean run always emits a `result` event, which already called finish().
    finish(code === 0 ? null : `Claude Code exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
  });
}

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const chunkId = () => `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function handleCompletion(req, res, body) {
  let invocation;
  let model;
  try {
    const parsed = JSON.parse(body);
    model = safeModel(parsed.model);
    invocation = buildInvocation(Array.isArray(parsed.messages) ? parsed.messages : []);
    invocation.stream = parsed.stream !== false;
  } catch (err) {
    sendJson(res, 400, { error: { message: String(err.message || err), type: "invalid_request_error" } });
    return;
  }

  log(`-> ${model} (${invocation.imageCount} image(s), stream=${invocation.stream})`);

  const child = spawnClaude({ system: invocation.system, stdin: invocation.stdin, model });
  const id = chunkId();
  const created = Math.floor(Date.now() / 1000);

  const timeout = setTimeout(() => {
    log("request timed out, killing claude");
    child.kill();
  }, REQUEST_TIMEOUT_MS);

  // If Pluely aborts (user hits stop), don't leave an orphan process behind.
  const onClientGone = () => child.kill();
  res.on("close", onClientGone);

  const cleanup = () => {
    clearTimeout(timeout);
    res.off("close", onClientGone);
  };

  if (invocation.stream) {
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (delta, finishReason = null) => {
      if (res.writableEnded) return;
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`
      );
    };

    send({ role: "assistant", content: "" });

    consumeClaudeStream(child, {
      onText: (text) => send({ content: text }),
      onError: (message) => send({ content: `\n\n**Erreur Claude Code :** ${message}` }),
      onDone: () => {
        cleanup();
        send({}, "stop");
        if (!res.writableEnded) res.end("data: [DONE]\n\n");
      },
    });
    return;
  }

  let full = "";
  let failure = null;
  consumeClaudeStream(child, {
    onText: (text) => {
      full += text;
    },
    onError: (message) => {
      failure = message;
    },
    onDone: () => {
      cleanup();
      if (failure && !full) {
        sendJson(res, 502, { error: { message: failure, type: "upstream_error" } });
        return;
      }
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: failure ? `${full}\n\n**Erreur :** ${failure}` : full },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    },
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    sendJson(res, 200, { ok: true, service: "pluely-claude-bridge", model: DEFAULT_MODEL });
    return;
  }

  if (req.method === "POST" && path === "/v1/chat/completions") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: { message: String(err.message || err), type: "invalid_request_error" } });
      return;
    }
    handleCompletion(req, res, body);
    return;
  }

  sendJson(res, 404, { error: { message: `Not found: ${req.method} ${path}`, type: "not_found" } });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — assuming another bridge is running, exiting`);
    process.exit(0);
  }
  log("server error:", err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (claude bin: "${CLAUDE_BIN}", default model: ${DEFAULT_MODEL})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

// When Pluely spawns us it holds our stdin open. Windows does not kill child
// processes when the parent dies, so a broken stdin pipe is our signal to exit
// rather than linger as an orphan.
if (process.env.PLUELY_BRIDGE_EXIT_ON_STDIN_CLOSE === "1") {
  process.stdin.resume();
  const parentGone = () => {
    log("parent closed stdin, shutting down");
    process.exit(0);
  };
  process.stdin.on("end", parentGone);
  process.stdin.on("close", parentGone);
  process.stdin.on("error", parentGone);
}
