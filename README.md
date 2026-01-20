# Codename Ralphie

## Overview

This is a Node.js application that implements an AI agent based on a basic version of the Ralph Wiggum loop. It uses Ollama to generate code segments or commands to build, modify, test, and run code for a given project task. The agent operates in a loop: generating segments, executing them as Node.js code (using child_process for shell or other languages), handling errors, and checking for project completion.

Key features:
- Stateful progress tracking with logs.
- Customizable Ollama model and host.
- Adjustable context length (default: 42000).
- Strict output formatting from the LLM to avoid extraneous text.

## The Basic Logic Flowchart

![A flowchart of our loop](https://github.com/MyMel2001/project-ralphie/raw/refs/heads/main/codename%20ralphie.svg)

## Installation

1. Ensure Node.js is installed (v14+ recommended).
2. Install dependencies:
   ```bash
   npm install ollama
   ```

3. Set up Ollama:
   - Run Ollama on your specified host (e.g., http://localhost:11434).
   - Pull the desired model, e.g., ```ollama pull ministral-3:8b```.

## Usage

Run the script with your project task as a CLI argument or a Markdown file path.

Basic command:
```bash
node ralphie.js "Your project task here"
```

### Options
- `--model <model-name>_`: Specify the Ollama model (default: ministral-3:8b).
- `--host <url>_`: Specify the Ollama host (default: http://localhost:11434).
- `--context-length <number>_`: Set the context length for Ollama (default: 42000).

Example with options:
```bash
node ralphie.js --model ministral-3:8b --host http://192.168.50.135:11434 --context-length 50000 "Build a simple Node.js server."
```

### Input Formats
- **Direct instructions**: Pass as string arguments.
- **Markdown spec file**: Provide the file path; it will be read as the main task.

## How It Works

The app follows this process:
1. Parse options and initial prompt.
2. Enter a loop:
   - Generate next code segment using Ollama (system prompt ensures raw Node.js code output).
   - Execute as Node.js (via temp file).
   - If error, append to error log and retry.
   - If success, append to progress log and check completion with Ollama.
3. Exit when "PROJECT_DONE" or completion check returns "yes".

For non-Node.js tasks (e.g., Python), the generated code uses Node's ```child_process``` to execute them.

## Examples

### Example 1: Simple Node.js Task
```bash
node ralphie.js --model ministral-3:8b --host http://192.168.50.135:11434 "Write Node.js code to print 'Hello, World!'."
```

Expected: Generates and runs ```console.log('Hello, World!');```.

### Example 2: Cross-Language Task
```bash
node ralphie.js --model ministral-3:8b --host http://192.168.50.135:11434 "Calculate the 10th Fibonacci number using Python via Node's child_process."
```

Expected: Generates Node.js code like:
```javascript
const { spawnSync } = require('child_process');
const result = spawnSync('python', ['-c', 'def fib(n): return n if n <= 1 else fib(n-1) + fib(n-2); print(fib(10))']);
console.log(result.stdout.toString().trim());
```

### Troubleshooting
- If Ollama returns formatted output, adjust the system prompt or model.
- For long projects, increase context length to avoid truncation.
- Errors are logged to console; the agent auto-corrects via loops.

## License

SPL-R5
