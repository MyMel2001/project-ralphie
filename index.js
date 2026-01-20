const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Ollama } = require('ollama');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// --- NATIVE TOOL DEFINITIONS ---
const nativeToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file from the local filesystem',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'The relative or absolute path to the file' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal_command',
      description: 'Execute a shell command (e.g., ls, mkdir, grep, git)',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The full shell command to run' } },
        required: ['command']
      }
    }
  }
];

// --- NATIVE TOOL HANDLERS ---


const handleNativeTool = (name, args) => {
  let fullPath = args.path || ""
  if (name === 'read_file') {
    try {
      return fs.readFileSync(path.resolve(args.path), 'utf-8');
    } catch (e) {
      return `Error reading file: ${e.message}`;
    }
  }
  if (name === 'search_and_replace' || name === 'find_and_replace') {
    let data = fs.readFileSync(fullPath, 'utf-8');
    if (!data.includes(args.search)) return `Error: String "${args.search}" not found in ${args.path}`;
    let newData = data.split(args.search).join(args.replace);
    fs.writeFileSync(fullPath, newData, 'utf-8');
    return `Successfully replaced text in ${args.path}`
  }
  if (name === 'write_file') {
    let data = fs.readFileSync(fullPath, 'utf-8');

    let newData = `${data}${args.newData || args.text || args.data}`
    fs.writeFileSync(fullPath, newData, 'utf-8');
    return `Successfully replaced text in ${args.path}`
  }
  if (name === 'run_terminal_command') {
    const result = spawnSync(args.command, { shell: true, encoding: 'utf-8' });
    return result.stdout || result.stderr || 'Command executed with no output.';
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
  const tools = [...nativeToolDefinitions]; // Start with Native Tools
  const clients = [];
  for (const serverPath of serverPaths) {
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
  }
  return { tools, clients };
}

function executeSegment(segment) {
  const tempFile = path.join(__dirname, 'temp.js');
  fs.writeFileSync(tempFile, segment);
  const result = spawnSync('node', [tempFile], { stdio: 'pipe', encoding: 'utf-8' });
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  return { error: (result.error || result.status !== 0), log: result.stderr || result.stdout };
}

async function main() {
  const { args, model, host, contextLength, mcpServers } = parseOptions();
  const ollama = new Ollama({ host });
  const { tools, clients } = await setupMCP(mcpServers);

  let mainPrompt = (args.length > 0 && fs.existsSync(args[0])) ? fs.readFileSync(args[0], 'utf-8') : args.join(' ');
  let errorLog = '';
  let progressLog = '';
  let projectStateSummary = "Project initialized. No progress yet.";
  
  const systemPromptGenerate = 'You are a code generator. Output only the raw next Node.js code segment without any codeblocks, markdown, formatting, or wrappers. For shell commands or other languages (like Python), use Node.js child_process to execute them directly without creating files or running code in shell. If the project is complete, output only "PROJECT_DONE". Do not include any other text, explanations, thoughts, speech, codeblocks, or markdown. Do not create anything that may make a feedback loop stuck, such as a server, launching GUI apps, or a while true loop without a proper breaking functionality.';
  const systemPromptCheck = 'You are a completion checker. Respond only with "yes" or "no" to whether the project is complete. No other text, explanations, thoughts, speech, codeblocks, or markdown.';
  const projectStateSummarySystem = "You are a project progress summarization bot. You create summaries for projects - showing what you've learned, the errors, and what needs to be done. Use plain text. Output ONLY the new summary, NOTHNG ELSE.";

  while (true) {
    const sliceLen = Math.round((Number(contextLength) / 6) / 2);
    const summarizePrompt = `Current detailed history (last ${sliceLen} characters):\n${progressLog.slice(sliceLen * -1)}\n\nCurrent error logs (last ${sliceLen} characters):\n${errorLog.slice(sliceLen * -1)}\n\nCurrent Project State Summary:\n${projectStateSummary}\n\nUpdate and shorten the Project State Summary to be concise, factual, and under ${Math.round(Number(contextLength) / 6)} tokens. Focus on: current achievements, important files created, current status, any remaining major goals.\n\nReminder: Output ONLY the new summary, nothing else.\n\nReminder 2: You should mainly be showing what you've learned, the errors, and what needs to be done.`;

    const summaryResponse = await ollama.chat({
      model: model,
      messages: [{ role: 'system', content: projectStateSummarySystem }, { role: 'user', content: summarizePrompt }],
      options: { num_ctx: contextLength }
    });
    projectStateSummary = summaryResponse.message.content.trim();

    const fullPrompt = `Main Task: ${mainPrompt}\n\nProgress Summary: ${projectStateSummary}\n\n${errorLog ? `LAST ERROR: ${errorLog}\nFix this error.` : "Generate the next code segment or command."}`;
    let messages = [{ role: 'system', content: systemPromptGenerate }, { role: 'user', content: fullPrompt }];
    let segment = "";

    while (true) {
      const response = await ollama.chat({ model, messages, tools, options: { num_ctx: contextLength } });
      const message = response.message;

      if (message.tool_calls?.length > 0) {
        messages.push(message);
        for (const call of message.tool_calls) {
          let toolResult;
          // Check if it's a Native Tool
          if (['read_file', 'run_terminal_command'].includes(call.function.name)) {
            toolResult = handleNativeTool(call.function.name, call.function.arguments);
          } else {
            // Otherwise handle via MCP
            const target = clients.find(c => c.toolNames.includes(call.function.name));
            if (target) {
              const res = await target.client.callTool({ name: call.function.name, arguments: call.function.arguments });
              toolResult = JSON.stringify(res.content);
            }
          }
          messages.push({ role: 'tool', content: toolResult, name: call.function.name });
        }
        continue; 
      }
      segment = message.content.trim();
      break;
    }

    if (segment.includes('PROJECT_DONE')) break;

    console.log(`\n--- Executing Segment ---\n${segment}`);
    const execResult = executeSegment(segment);

    if (execResult.error || errorLog.includes("not found") || errorLog.includes("Command failed")) {
      errorLog = execResult.log;
      console.log(`❌ Error: ${errorLog}`);
    } else {
      console.log(`✅ Success: ${execResult.log}`);
      progressLog += `\nSuccessful segment: ${segment}\nOutput: ${execResult.log}`;
      errorLog = ''; 

      const checkPrompt = `${mainPrompt}\n\nProgress Log: ${progressLog}\n\nLast segment executed successfully. Is the project complete?`;
      const checkResponse = await ollama.chat({
        model,
        messages: [{ role: 'system', content: systemPromptCheck }, { role: 'user', content: checkPrompt }],
        options: { num_ctx: contextLength }
      });

      if (checkResponse.message.content.toLowerCase().includes('yes')) break;
    }
  }
  console.log('Project done.');
}

main().catch(console.error);
