const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Ollama } = require('ollama');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const readline = require('readline/promises');

// --- NATIVE TOOL DEFINITIONS ---
const nativeToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the local filesystem',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The path to the file' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or append text to a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          text: { type: 'string', description: 'Content to write' },
          append: { type: 'boolean', description: 'If true, append instead of overwrite', default: false }
        },
        required: ['path', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_and_replace',
      description: 'Find and replace a string in a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          search: { type: 'string' },
          replace: { type: 'string' }
        },
        required: ['path', 'search', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Execute a shell command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The full shell command' } },
        required: ['command']
      }
    }
  }
];

const NATIVE_TOOL_NAMES = nativeToolDefinitions.map(t => t.function.name);

const handleNativeTool = (name, args) => {
  let fullPath = args.path ? path.resolve(process.cwd(), args.path) : "";

  try {
    if (name === 'read_file') return fs.readFileSync(fullPath, 'utf-8');

    if (name === 'search_and_replace') {
      let data = fs.readFileSync(fullPath, 'utf-8');
      if (!data.includes(args.search)) return `Error: String "${args.search}" not found.`;
      let newData = data.split(args.search).join(args.replace);
      fs.writeFileSync(fullPath, newData, 'utf-8');
      return `Successfully replaced text in ${args.path}`;
    }

    if (name === 'write_file') {
      if (args.append) {
        fs.appendFileSync(fullPath, args.text, 'utf-8');
        return `Successfully appended to ${args.path}`;
      } else {
        fs.writeFileSync(fullPath, args.text, 'utf-8');
        return `Successfully wrote to ${args.path}`;
      }
    }

    if (name === 'run_terminal_command') {
      const result = spawnSync(args.command, {
        shell: true,
        encoding: 'utf-8',
        timeout: 30000,
        cwd: process.cwd()
      });
      return result.stdout || result.stderr || 'Command executed (no output).';
    }
  } catch (e) {
    return `Error executing ${name}: ${e.message}`;
  }
};


function parseOptions() {
  let args = process.argv.slice(2);
  let model = 'ministral-3:8b';
  let host = 'http://localhost:11434';
  let contextLength = 42000;
  let mcpServers = [];
  let i = 0;

  while (i < args.length) {
    if (args[i] === '--model') { model = args[i + 1]; args.splice(i, 2); }
    else if (args[i] === '--host') { host = args[i + 1]; args.splice(i, 2); }
    else if (args[i] === '--context-length') { contextLength = parseInt(args[i + 1], 10); args.splice(i, 2); }
    else if (args[i] === '--mcp') { mcpServers.push(args[i + 1]); args.splice(i, 2); }
    else { i++; }
  }

  return { args, model, host, contextLength, mcpServers };
}

async function setupMCP(serverPaths) {
  const tools = [...nativeToolDefinitions];
  const clients = [];

  for (const serverPath of serverPaths) {
    try {
      const transport = new StdioClientTransport({ command: 'npx', args: [serverPath] });
      const client = new Client({ name: "Ralphie-Host", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);

      const { tools: serverTools } = await client.listTools();
      const formatted = serverTools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }));

      tools.push(...formatted);
      clients.push({ client, toolNames: serverTools.map(t => t.name) });
    } catch (e) {
      console.error(`Failed to load MCP server ${serverPath}: ${e.message}`);
    }
  }

  return { tools, clients };
}

// FIX: explicit MCP shutdown so Node can exit cleanly
async function shutdownMCP(clients) {
  for (const { client } of clients) {
    try {
      await client.close();
    } catch {}
  }
}

async function main() {
  const { args, model, host, contextLength, mcpServers } = parseOptions();
  const ollama = new Ollama({ host });
  const { tools, clients } = await setupMCP(mcpServers);

  let initialInput =
    (args.length > 0 && fs.existsSync(args[0]))
      ? fs.readFileSync(args[0], 'utf-8')
      : args.join(' ');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const isReplMode = !initialInput;

  let progressLog = '';
  let projectStateSummary = "No active task.";

  const systemPromptRouter = 'You are a router. Determine if the user request is a "CHAT" (a question, greeting, or explanation request, etc) or an "ACTION" (such as requires writing code, running commands, or multi-step execution). Respond ONLY with the word "CHAT" or "ACTION".';
  const systemPromptGenerate = 'You are an action executor. Accomplish the user\'s task by using the available tools. Do not generate or execute code directly; instead, use the provided tools for any file system modifications, command executions, or other actions. For shell commands, use the run_terminal_command tool. For creating or modifying files, use write_file or search_and_replace. You can reason step by step in your response before calling tools. Reason about what to do next, then call tools if needed. If no more actions needed, output "PROJECT_DONE" (optionally followed by ": message"). Do not call tools after outputting "PROJECT_DONE".';
  const systemPromptCheck = 'You are a completion checker. Respond only with "yes" or "no" to whether the project is complete. No other text, explanations, thoughts, speech, codeblocks, or markdown. You have basic tool calling access, btw - so don\'t be afraid to use some tool calls in case you need to test something! Just remember - to test something: launch it for 60 seconds, close it, check error logs.';
  const projectStateSummarySystem = "You are a project progress summarization bot. You create summaries for projects - showing what you've learned, the errors, and what needs to be done. Use plain text. Output ONLY the new summary, NOTHNG ELSE.";
  while (true) {
    let currentTask = initialInput;

    if (isReplMode) {
      currentTask = await rl.question('\n[Sammy] > ');
      if (['exit', 'quit'].includes(currentTask.toLowerCase())) break;
      if (!currentTask.trim()) continue;
    }

    const routeResponse = await ollama.chat({
      model,
      messages: [
        { role: 'system', content: systemPromptRouter },
        { role: 'user', content: currentTask }
      ]
    });

    const isAction = routeResponse.message.content.includes("ACTION");

    if (!isAction) {
      const chatResponse = await ollama.chat({
        model,
        messages: [
          { role: 'system', content: "You are a helpful assistant named Sammy." },
          { role: 'user', content: currentTask }
        ]
      });

      console.log(`\n${chatResponse.message.content}`);
      if (!isReplMode) break;
      continue;
    }

    let errorLog = '';

    while (true) {
      const sliceLen = Math.round((Number(contextLength) / 6) / 2);
      const summarizePrompt =
        `History: ${progressLog.slice(-sliceLen)}\nErrors: ${errorLog.slice(-sliceLen)}\nSummary: ${projectStateSummary}\nUpdate summary.`;

      const summaryResponse = await ollama.chat({
        model,
        messages: [
          { role: 'system', content: projectStateSummarySystem },
          { role: 'user', content: summarizePrompt }
        ],
        options: { num_ctx: contextLength }
      });

      projectStateSummary = summaryResponse.message.content.trim();

      const fullPrompt =
          `Task: ${currentTask}\nSummary: ${projectStateSummary}\n${errorLog ? `FIX ERROR: ${errorLog}` : "Continue with next actions."}`;

      let messages = [
        { role: 'system', content: systemPromptGenerate },
        { role: 'user', content: fullPrompt }
      ];

      while (true) {
        const response = await ollama.chat({ model, messages, tools, options: { num_ctx: contextLength } });
        const message = response.message;

        if (message.tool_calls?.length > 0) {
          messages.push(message);

          for (const call of message.tool_calls) {
            let toolResult;

            if (NATIVE_TOOL_NAMES.includes(call.function.name)) {
              console.log(`\n--- Executing Action ---\n${call.function.name}`);
              toolResult = handleNativeTool(call.function.name, call.function.arguments);
            } else {
              const target = clients.find(c => c.toolNames.includes(call.function.name));
              if (target) {
                const res = await target.client.callTool({
                  name: call.function.name,
                  arguments: call.function.arguments
                });
                toolResult = res.content.map(c => c.text || JSON.stringify(c)).join('\n');
              }
            }

            messages.push({
              role: 'tool',
              content: toolResult || "Tool error",
              name: call.function.name
            });
          }

          continue;
        }

        segment = message.content.trim();
        break;
      }

      if (segment.includes('PROJECT_DONE')) break;

      console.log(`Tool result: ${toolResult}`);

      if (toolResult.includes('Error')) {
        errorLog = toolResult;
        console.log(`❌ Error: ${errorLog}`);
      } else {
        console.log(`✅ Success: ${toolResult}`);
        progressLog += `\nCode: ${segment}\nOutput: ${toolResult}`;
        errorLog = '';

        let checkMessages = [
          { role: 'system', content: systemPromptCheck },
          { role: 'user', content: `Task: ${currentTask}\nLog: ${progressLog}\nDone?` }
        ];

        while (true) {
          const checkResponse = await ollama.chat({ model, messages: checkMessages, tools, options: { num_ctx: contextLength } });
          const checkMessage = checkResponse.message;

          if (checkMessage.tool_calls?.length > 0) {
            checkMessages.push(checkMessage);

            for (const call of checkMessage.tool_calls) {
              let toolResult;

              if (NATIVE_TOOL_NAMES.includes(call.function.name)) {
                toolResult = handleNativeTool(call.function.name, call.function.arguments);
              } else {
                const target = clients.find(c => c.toolNames.includes(call.function.name));
                if (target) {
                  const res = await target.client.callTool({
                    name: call.function.name,
                    arguments: call.function.arguments
                  });
                  toolResult = res.content.map(c => c.text || JSON.stringify(c)).join('\n');
                }
              }

              checkMessages.push({
                role: 'tool',
                content: toolResult || "Tool error",
                name: call.function.name
              });
            }

            continue;
          }

          if (checkMessage.content.toLowerCase().includes('yes')) break;
          break;
        }

        if (checkResponse.message.content.toLowerCase().includes('yes')) break;
      }
    }

    if (!isReplMode) break;
  }

  rl.close();
  await shutdownMCP(clients); // FIX: clean shutdown
  console.log('Session closed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
