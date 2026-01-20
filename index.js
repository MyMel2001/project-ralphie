const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Ollama } = require('ollama'); // Assuming ollama library is installed: npm install ollama

// Parse CLI arguments for custom model, host, and context length
function parseOptions() {
  let args = process.argv.slice(2);
  let model = 'ministral-3:8b';
  let host = 'http://localhost:11434';
  let contextLength = 42000;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--model' && i + 1 < args.length) {
      model = args[i + 1];
      args.splice(i, 2);
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      args.splice(i, 2);
    } else if (args[i] === '--context-length' && i + 1 < args.length) {
      contextLength = parseInt(args[i + 1], 10);
      args.splice(i, 2);
    } else {
      i++;
    }
  }
  return { args, model, host, contextLength };
}

// Function to read input: either from file or remaining CLI args
function getInitialPrompt(args) {
  if (args.length === 0) {
    console.error('Please provide a markdown spec file path or instructions as CLI arguments.');
    process.exit(1);
  }

  let prompt = '';
  if (fs.existsSync(args[0])) {
    // Assume first arg is file path if it exists
    prompt = fs.readFileSync(args[0], 'utf-8');
  } else {
    // Otherwise, treat args as direct instructions
    prompt = args.join(' ');
  }

  return `Main Task: ${prompt}\n\nGenerate the next code segment or command to advance the project. If the project is complete, respond with "PROJECT_DONE".`;
}

// Function to execute a code segment as Node.js code
function executeSegment(segment) {
  // Write to temp file and run with Node
  const tempFile = path.join(__dirname, 'temp.js');
  fs.writeFileSync(tempFile, segment);
  const result = spawnSync('node', [tempFile], { stdio: 'pipe', encoding: 'utf-8' });
  fs.unlinkSync(tempFile); // Clean up
  if (result.error || result.status !== 0) {
    return { error: true, log: result.stderr || result.stdout };
  }
  return { error: false, log: result.stdout };
}

// Main loop
async function main() {
  const { args, model, host, contextLength } = parseOptions();
  const ollamaInstance = new Ollama({ host });
  let mainPrompt = getInitialPrompt(args);
  let errorLog = '';
  let progressLog = '';

  const systemPromptGenerate = 'You are a code generator. Output only the raw next Node.js code segment without any codeblocks, markdown, formatting, or wrappers. For shell commands or other languages (like Python), use Node.js child_process to execute them directly without creating files or running code in shell. If the project is complete, output only "PROJECT_DONE". Do not include any other text, explanations, thoughts, speech, codeblocks, or markdown.';
  const systemPromptCheck = 'You are a completion checker. Respond only with "yes" or "no" to whether the project is complete. No other text, explanations, thoughts, speech, codeblocks, or markdown.';

  while (true) {
    // Clean slate: only main prompt + progress + error log
    const fullPrompt = `${mainPrompt}\n\nProgress Log: ${progressLog}\n\nError Log (if any): ${errorLog}\n\nGenerate the next code segment or command. If incomplete, continue. If done, say "PROJECT_DONE".`;

    // Use Ollama to generate the next segment
    const response = await ollamaInstance.chat({
      model: model,
      messages: [
        { role: 'system', content: systemPromptGenerate },
        { role: 'user', content: fullPrompt }
      ],
      options: { num_ctx: contextLength }
    });

    const segment = response.message.content.trim();

    if (segment === 'PROJECT_DONE') {
      console.log('Project done.');
      break;
    }

    // Execute the segment
    console.log(`Executing segment:\n${segment}`);
    const execResult = executeSegment(segment);

    if (execResult.error) {
      errorLog = execResult.log;
      console.log(`Error: ${errorLog}`);
      // Loop back with error appended
    } else {
      console.log(`Output: ${execResult.log}`);
      // Append to progress log
      progressLog += `\nSuccessful segment: ${segment}\nOutput: ${execResult.log}`;
      // Check if incomplete: ask Ollama if project is done
      const checkPrompt = `${mainPrompt}\n\nProgress Log: ${progressLog}\n\nLast segment executed successfully. Output: ${execResult.log}\n\nIs the project complete? Respond with "yes" or "no".`;
      const checkResponse = await ollamaInstance.chat({
        model: model,
        messages: [
          { role: 'system', content: systemPromptCheck },
          { role: 'user', content: checkPrompt }
        ],
        options: { num_ctx: contextLength }
      });

      const isComplete = checkResponse.message.content.trim().toLowerCase();
      if (isComplete === 'yes') {
        console.log('Project done.');
        break;
      }
      // If no, continue; reset error log if success
      errorLog = '';
    }
  }
}

main().catch(console.error);
