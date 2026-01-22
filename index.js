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
          text: { type: 'string', description: 'Content to write' }
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

    if (name === 'search_and_replace' || name === 'find_and_replace') {
      let data = fs.readFileSync(fullPath, 'utf-8');
      if (!data.includes(args.search)) return `Error: String "${args.search}" not found.`;
      let newData = data.split(args.search).join(args.replace);
      fs.writeFileSync(fullPath, newData, 'utf-8');
      return `Successfully replaced text in ${args.path}`;
    }

    if (name === 'write_file') {
      fs.writeFileSync(fullPath, args.text || args.data || args.newData, 'utf-8');
      return `Successfully wrote to ${args.path}`;
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
  const systemPromptAgent = 'You are an action executor. Accomplish the user\'s task by using the available tools. Do not generate or execute code directly; instead, use the provided tools for any file system modifications, command executions, or other actions. For shell commands, use the run_terminal_command tool. For creating or modifying files, use write_file or search_and_replace. You can reason step by step in your response before calling tools. Reason about what to do next, then call tools if needed. If you think the step is complete, output your final thoughts without any special markers. You have basic tool calling access - so don\'t be afraid to use some tool calls!';
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

    progressLog = '';
    projectStateSummary = "No active task.";

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
        { role: 'system', content: systemPromptAgent },
        { role: 'user', content: fullPrompt }
      ];

      let iterationLog = '';
      let toolErrors = [];
      let finalContent = '';

      while (true) {
        const response = await ollama.chat({ model, messages, tools, options: { num_ctx: contextLength } });
        const message = response.message;

        iterationLog += `\nAssistant: ${message.content || ''}`;

        if (message.tool_calls?.length > 0) {
          messages.push(message);

          iterationLog += `\nTool calls: ${JSON.stringify(message.tool_calls)}`;

          for (const call of message.tool_calls) {
            let toolResult;
            const name = call.function.name;
            const args = call.function.arguments;

            if (NATIVE_TOOL_NAMES.includes(name)) {
              toolResult = handleNativeTool(name, args);
            } else {
              const target = clients.find(c => c.toolNames.includes(name));
              if (target) {
                const res = await target.client.callTool({
                  name,
                  arguments: args
                });
                toolResult = res.content.map(c => c.text || JSON.stringify(c)).join('\n');
              } else {
                toolResult = 'Tool not found';
              }
            }

            if (toolResult.startsWith('Error') || toolResult === 'Tool error' || toolResult === 'Tool not found') {
              toolErrors.push(toolResult);
            }

            iterationLog += `\nTool result for ${name}: ${toolResult}`;

            messages.push({
              role: 'tool',
              content: toolResult || "Tool error",
              name
            });
          }

          continue;
        }

        finalContent = message.content.trim();
        break;
      }

      console.log(`\n--- Action Step ---\n${iterationLog}`);

      if (toolErrors.length > 0) {
        errorLog = toolErrors.join('\n');
        console.log(`❌ Error: ${errorLog}`);
      } else {
        console.log(`✅ Success: ${iterationLog}`);
        progressLog += `\nStep: ${iterationLog}`;
        errorLog = '';
      }

      if (toolErrors.length === 0) {
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
              const name = call.function.name;
              const args = call.function.arguments;

              if (NATIVE_TOOL_NAMES.includes(name)) {
                toolResult = handleNativeTool(name, args);
              } else {
                const target = clients.find(c => c.toolNames.includes(name));
                if (target) {
                  const res = await target.client.callTool({
                    name,
                    arguments: args
                  });
                  toolResult = res.content.map(c => c.text || JSON.stringify(c)).join('\n');
                } else {
                  toolResult = 'Tool not found';
                }
              }

              checkMessages.push({
                role: 'tool',
                content: toolResult || "Tool error",
                name
              });
            }

            continue;
          }

          if (checkMessage.content.toLowerCase().includes('yes')) {
            console.log('\nProject complete.');
            break;
          } else {
            break;
          }
        }

        if (checkMessage.content.toLowerCase().includes('yes')) break;
      }
    }

    if (!isReplMode) break;
  }

  rl.close();
  await shutdownMCP(clients);
  console.log('Session closed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
