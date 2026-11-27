// Agent transcripts in the shapes the lender streams (Claude Code stream-json and Codex JSON events), captured
// from real jobs and scrubbed: session ids, signatures and request ids are gone, the job folder is generic.
const at = seconds => new Date(Date.parse('2026-10-20T11:19:00Z') + seconds * 1000).toISOString();
const cwd = '/tmp/wf-job-wf-0000000000000000-AbCdEf';
const say = (s, text) => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'text', text}]}, timestamp: at(s)});
const use = (s, id, name, input) => ({type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id, name, input}]}, timestamp: at(s)});
const result = (s, id, content, extra = {}) => ({type: 'user', message: {role: 'user', content: [{tool_use_id: id, type: 'tool_result', content, ...extra}]}, timestamp: at(s)});
const lines = list => list.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');

/** A running Claude job: messages, reads, edits, a failed and a passing command, and one command still running. */
export const RUNNING_CLAUDE = lines([
  {type: 'system', subtype: 'init', cwd, model: 'claude-sonnet-5', tools: ['Bash', 'Read', 'Edit']},
  {type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50},
  {type: 'assistant', message: {role: 'assistant', content: [{type: 'thinking', thinking: '', signature: 'x'}]}, timestamp: at(2)},
  say(4, 'I’ll check what’s available in the sandbox, then write a script that renders a deep zoom of the Mandelbrot set with flat toon bands and ink outlines.'),
  use(6, 'toolu_1', 'Bash', {command: 'python3 -c "import numpy, PIL; print(numpy.__version__, PIL.__version__)"', description: 'Check for numpy and Pillow'}),
  result(7, 'toolu_1', 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nModuleNotFoundError: No module named \'numpy\'', {is_error: true}),
  say(9, 'I’ll use a venv to avoid touching the system Python environment.'),
  use(10, 'toolu_2', 'Bash', {command: 'python3 -m venv /tmp/mandel_venv && /tmp/mandel_venv/bin/pip install --quiet numpy pillow && /tmp/mandel_venv/bin/python -c "import numpy, PIL; print(numpy.__version__, PIL.__version__)"', description: 'Create a venv and install numpy and Pillow'}),
  result(31, 'toolu_2', '2.3.4 12.0.0', {is_error: false}),
  say(33, 'That worked. Now let’s write the renderer.'),
  use(35, 'toolu_3', 'Write', {file_path: cwd + '/mandelbrot_cel.py', content: 'import numpy as np\n'}),
  result(35, 'toolu_3', 'File created successfully at: ' + cwd + '/mandelbrot_cel.py'),
  use(37, 'toolu_4', 'Read', {file_path: cwd + '/README.md'}),
  result(37, 'toolu_4', '1\t# Mandelbrot\n2\t'),
  use(39, 'toolu_5', 'Grep', {pattern: 'BANDS', path: cwd}),
  result(39, 'toolu_5', 'mandelbrot_cel.py'),
  say(80, 'The output has the right spiral structure but the outlines are too noisy — the banding is aliasing against fractal fine-detail. I’ll add supersampling (render at `2x`, downsample, then posterize) to get clean toon bands and crisp ink lines.'),
  use(86, 'toolu_6', 'Edit', {file_path: cwd + '/mandelbrot_cel.py', old_string: 'MAX_ITER = 800', new_string: 'MAX_ITER = 800\nSS = 2'}),
  result(86, 'toolu_6', 'The file ' + cwd + '/mandelbrot_cel.py has been updated successfully.'),
  use(97, 'toolu_7', 'Bash', {command: 'cd /tmp && time /tmp/mandel_venv/bin/python mandelbrot_cel.py', description: 'Run updated supersampled Mandelbrot cel-shading render', timeout: 300000}),
  {type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_7', description: 'Run updated supersampled Mandelbrot cel-shading render'},
  {type: 'tool_progress', tool_use_id: 'toolu_7-heartbeat-0', tool_name: 'Bash', parent_tool_use_id: 'toolu_7', elapsed_time_seconds: 30, heartbeat: true},
  {type: 'tool_progress', tool_use_id: 'toolu_7-heartbeat-1', tool_name: 'Bash', parent_tool_use_id: 'toolu_7', elapsed_time_seconds: 60, heartbeat: true},
  '',
]);

/** A finished Claude job, as captured end to end. */
export const FINISHED_CLAUDE = lines([
  {type: 'system', subtype: 'init', cwd, model: 'claude-sonnet-5'},
  {type: 'rate_limit_event', rate_limit_info: {status: 'allowed'}},
  use(0, 'toolu_a', 'Bash', {command: 'find ' + cwd + ' -iname "sum*" -not -path "*/node_modules/*"', description: 'Locate sum.mjs and related test files'}),
  result(0.2, 'toolu_a', cwd + '/sum.test.mjs\n' + cwd + '/sum.mjs', {is_error: false}),
  use(2.6, 'toolu_b', 'Read', {file_path: cwd + '/sum.mjs'}),
  result(2.6, 'toolu_b', '1\texport function sum(a, b) { return a - b; }\n2\t'),
  say(4.6, 'The bug: `sum` used `a - b` instead of `a + b`.'),
  use(6.1, 'toolu_c', 'Edit', {file_path: cwd + '/sum.mjs', old_string: 'export function sum(a, b) { return a - b; }', new_string: 'export function sum(a, b) { return a + b; }'}),
  result(6.1, 'toolu_c', 'The file ' + cwd + '/sum.mjs has been updated successfully.'),
  use(8.2, 'toolu_d', 'Bash', {command: 'node --test sum.test.mjs', description: 'Run sum.test.mjs tests'}),
  result(9.7, 'toolu_d', 'TAP version 13\n# Subtest: sum adds two positive integers\nok 1 - sum adds two positive integers\n# Subtest: sum adds negative integers\nok 2 - sum adds negative integers\n1..2\n# tests 2\n# pass 2\n# fail 0', {is_error: false}),
  say(11.4, 'Fixed `sum.mjs:1` — it used subtraction (`a - b`) instead of addition. Changed it to `a + b`; both tests in `sum.test.mjs` now pass.'),
  {type: 'result', subtype: 'success', is_error: false, duration_ms: 15081, result: 'Fixed `sum.mjs:1` — it used subtraction (`a - b`) instead of addition. Changed it to `a + b`; both tests in `sum.test.mjs` now pass.'},
]);

/** A Codex job: the same kinds in Codex's item events. */
export const CODEX = lines([
  {type: 'thread.started', thread_id: 't'},
  {type: 'item.completed', item: {id: 'i0', type: 'agent_message', text: 'Running the tests first.'}},
  {type: 'item.started', item: {id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress'}},
  {type: 'item.completed', item: {id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: '1 failing', exit_code: 1, status: 'failed'}},
  {type: 'item.completed', item: {id: 'i2', type: 'file_change', changes: [{path: 'src/sum.mjs', kind: 'update'}]}},
  {type: 'turn.completed', usage: {input_tokens: 13}},
]);
