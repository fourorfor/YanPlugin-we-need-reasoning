'use strict';

const fs = require('node:fs');
const path = require('node:path');
const data = require('./registers-data.json');

const SEED = fs.readFileSync(path.join(__dirname, '..', 'seed.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
if (!SEED) throw new Error('seed.txt 为空，插件包不完整');

const SEED_HEAD = SEED.slice(0, 48);
const SYSTEM_REGISTER_HEAD = data.SYSTEM_REGISTER_HEAD;
const SYSTEM_REGISTER = data.SYSTEM_REGISTER;
const NEAREST_GUIDANCE = data.NEAREST_GUIDANCE;
const CONTINUE_WORK = data.CONTINUE_WORK;
const TOOL_STEP_ANCHOR = data.TOOL_STEP_ANCHOR;
const TEAM_REGISTER_HINT = data.TEAM_REGISTER_HINT;
const COMPACTION_REGISTER_HEAD = data.COMPACTION_REGISTER_HEAD;
const COMPACTION_REGISTER = data.COMPACTION_REGISTER;
const TOOL_DESC_GUIDANCE = data.TOOL_DESC_GUIDANCE;

const TEAM_TOOL_PATTERN = /(?:send_message|send_agent|spawn|subagent|sub_agent|task|workflow|delegate|team|agent)/i;

// Program-text sanitizer (upstream v4.3.2): rewrites drift-inducing phrases in
// system/developer prompts and tool schemas BEFORE SYSTEM_REGISTER is appended.
const PROGRAM_REPLACEMENTS = [
  [/\bthe user\b/gi, match => `${match[0] === 'T' ? 'The' : 'the'} requester`],
  [/\blet\s+me\b/gi, match => `${match[0] === 'L' ? 'We' : 'we'} need`],
  [/\bI'll\b/gi, match => `${match[0] === 'I' ? 'We' : 'we'} will`],
  [/\bI\s+will\b/gi, match => `${match[0] === 'I' ? 'We' : 'we'} will`],
  [/\bHmm\b/gi, match => (match[0] === 'H' ? 'Need' : 'need')]
];

function sanitizeProgramText(text) {
  if (typeof text !== 'string' || !text.length) return text;
  let out = text;
  for (const [pattern, replacement] of PROGRAM_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function sanitizeProgramMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    if (!message || (message.role !== 'system' && message.role !== 'developer')) continue;
    if (typeof message.content === 'string') {
      const next = sanitizeProgramText(message.content);
      if (next !== message.content) { message.content = next; count += 1; }
    } else if (Array.isArray(message.content)) {
      let partChanged = false;
      for (const part of message.content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          const next = sanitizeProgramText(part.text);
          if (next !== part.text) { part.text = next; partChanged = true; }
        }
      }
      if (partChanged) count += 1;
    }
  }
  return count;
}

function sanitizeSchemaText(node) {
  if (Array.isArray(node)) {
    let changed = false;
    for (let i = 0; i < node.length; i += 1) {
      if (sanitizeSchemaText(node[i])) changed = true;
    }
    return changed;
  }
  if (!node || typeof node !== 'object') return false;
  let changed = false;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && (key === 'description' || key === 'title' || key === 'summary')) {
      const next = sanitizeProgramText(value);
      if (next !== value) { node[key] = next; changed = true; }
    } else if (value && typeof value === 'object') {
      if (sanitizeSchemaText(value)) changed = true;
    }
  }
  return changed;
}

function sanitizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) return 0;
  let count = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const target = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    let changed = false;
    if (typeof target.description === 'string') {
      const next = sanitizeProgramText(target.description);
      if (next !== target.description) { target.description = next; changed = true; }
    }
    if (target.parameters && typeof target.parameters === 'object') {
      if (sanitizeSchemaText(target.parameters)) changed = true;
    }
    if (changed) count += 1;
  }
  return count;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    }).join('');
  }
  return '';
}

function appendText(content, text) {
  if (typeof content === 'string') return content ? `${content}\n\n${text}` : text;
  if (Array.isArray(content)) return [...content, { type: 'text', text: `\n\n${text}` }];
  if (content == null) return text;
  return content;
}

function parseTargetGroups(rules) {
  return String(rules || '')
    .split(';')
    .map(group => group.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))
    .filter(group => group.length > 0);
}

function matchesTarget(model, rules) {
  const name = String(model || '').trim().toLowerCase();
  if (!name) return false;
  return parseTargetGroups(rules).some(group => group.includes('*') || group.every(keyword => name.includes(keyword)));
}

function systemTextOf(body) {
  const parts = [];
  if (typeof body.instructions === 'string') parts.push(body.instructions);
  if (typeof body.system === 'string') parts.push(body.system);
  if (Array.isArray(body.system)) parts.push(body.system.map(part => part && part.text || '').join('\n'));
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message && (message.role === 'system' || message.role === 'developer')) parts.push(textOfContent(message.content));
    }
  }
  return parts.join('\n');
}

/**
 * Yan 自身的上下文压缩请求没有稳定标记。这里用两个条件一起判断：
 * 没有工具定义，且 program text 同时出现“压缩/摘要”和“对话/上下文”语义。
 * 误判时可通过配置关闭识别或改用 seedMode=task。
 */
function looksLikeCompaction(body) {
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (tools > 0) return false;
  const text = systemTextOf(body);
  return /(?:compact|compaction|summari[sz]e|summary|摘要|压缩)/i.test(text)
    && /(?:conversation|context|transcript|history|对话|上下文|历史)/i.test(text);
}

function appendTeamHints(body, hint = TEAM_REGISTER_HINT) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  let count = 0;
  for (const tool of tools) {
    const fn = tool && (tool.function || tool);
    if (!fn || typeof fn !== 'object') continue;
    const name = String(fn.name || tool.name || '');
    if (!TEAM_TOOL_PATTERN.test(name)) continue;
    const description = String(fn.description || '');
    if (description.includes(TEAM_REGISTER_HINT.slice(0, 40))) continue;
    fn.description = description ? `${description}\n\n${hint}` : hint;
    count += 1;
  }
  return count;
}

function seedMessage(seed, options = {}) {
  const message = { role: 'assistant', content: seed };
  if (options.reasoningContent !== false) message.reasoning_content = seed;
  return message;
}

function findLastAssistantWithTools(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) return index;
  }
  return -1;
}

function findFirstUserIndex(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index] && messages[index].role === 'user') return index;
  }
  return -1;
}

function findLastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index] && messages[index].role === 'user') return index;
  }
  return -1;
}

function findLastSystemInsertIndex(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return -1;
  if (messages[0] && (messages[0].role === 'system' || messages[0].role === 'developer')) {
    let last = 0;
    while (messages[last + 1] && (messages[last + 1].role === 'system' || messages[last + 1].role === 'developer')) {
      last += 1;
    }
    return last;
  }
  return messages.findIndex(message => message && (message.role === 'system' || message.role === 'developer'));
}

/**
 * 通用 content 填充：
 * - `mirror-reasoning`（默认，零回撤缓存友好）：所有空 content 的 assistant 确定性地镜像填入
 *   自身的 `reasoning_content`，永远不在最新一条上临时插删 `SEED + CONTINUE_WORK`，保证前缀严格单调递增；
 * - `seed-continue-reasoning`（激进模式，对齐上游 v4.3.2）：当前任务段最新 tool-call assistant
 *   填 `seed + CONTINUE_WORK + 自身 reasoning`，其余空 content assistant 镜像自身 `reasoning_content`；
 * - 已有可见正文（非空 content）永不覆盖。
 */
function fillAssistantContent(messages, seed, options = {}) {
  const mode = String(options.contentFill ?? 'mirror-reasoning').toLowerCase();
  if ((mode !== 'mirror-reasoning' && mode !== 'seed-continue-reasoning') || !Array.isArray(messages)) return 0;
  let latest = -1;
  if (mode === 'seed-continue-reasoning' && seed) {
    const lastUser = findLastUserIndex(messages);
    const scopeStart = lastUser >= 0 ? lastUser : 0;
    for (let i = messages.length - 1; i >= scopeStart; i -= 1) {
      const msg = messages[i];
      if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        latest = i;
        break;
      }
    }
  }
  let filled = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    if (textOfContent(msg.content).trim().length > 0) continue;
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : '';
    if (i === latest) {
      msg.content = reasoning
        ? `${seed}\n\n${CONTINUE_WORK}\n\n${reasoning}`
        : `${seed}\n\n${CONTINUE_WORK}`;
      filled += 1;
    } else if (reasoning) {
      msg.content = reasoning;
      filled += 1;
    }
  }
  return filled;
}

/**
 * 贴身引导（对齐上游 v4.3.2 nearestGuidance = 'both'）。
 * 在最新 tool-call assistant 的空 content 和/或 reasoning_content 追加 NEAREST_GUIDANCE。
 */
function applyNearestGuidance(messages, options = {}) {
  const mode = String(options.nearestGuidance ?? 'both').toLowerCase();
  if (!['content', 'reasoning', 'both'].includes(mode) || !Array.isArray(messages)) return false;
  const lastUser = findLastUserIndex(messages);
  const scopeStart = lastUser >= 0 ? lastUser : 0;
  let index = -1;
  for (let i = messages.length - 1; i >= scopeStart; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  const msg = messages[index];
  const head = NEAREST_GUIDANCE.slice(0, 48);
  let changed = false;
  const wantContent = mode === 'content' || mode === 'both';
  const wantReasoning = mode === 'reasoning' || mode === 'both';
  if (wantContent && textOfContent(msg.content).trim().length === 0) {
    msg.content = NEAREST_GUIDANCE;
    changed = true;
  }
  if (wantReasoning) {
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : '';
    if (!reasoning.includes(head)) {
      msg.reasoning_content = reasoning ? `${reasoning}\n\n${NEAREST_GUIDANCE}` : NEAREST_GUIDANCE;
      changed = true;
    }
  }
  return changed;
}

/**
 * chat/completions 注入（对齐上游 dsh-we-need-plugin v4.3.2 全量杠杆）：
 * - sanitizeProgram：先清洗 system/developer 与 tools schema 中的漂移词；
 * - system/developer 末尾追加 SYSTEM_REGISTER；
 * - user 轮与工具轮（toolStepReseed）均在最后一条 user task 前保留 assistant seed；
 * - contentFill：向空 assistant content 填充 seed + CONTINUE_WORK + 自身 reasoning（跨边界镜像历史）；
 * - 工具步在最新 tool-call assistant 的 reasoning_content 追加 anchor + seed 与 nearestGuidance；
 * - 幂等，不重复插入。
 */
function injectChat(body, options = {}) {
  const result = { changed: false, actions: [], seedInjected: false, anchorInjected: false, contentFilled: 0, teamTools: 0 };
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return result;

  if (options.sanitizeProgram !== false) {
    const sanitizedMsgs = sanitizeProgramMessages(body.messages);
    const sanitizedTools = sanitizeToolDefinitions(body.tools);
    if (sanitizedMsgs > 0 || sanitizedTools > 0) {
      result.changed = true;
      result.actions.push(`sanitize-program:${sanitizedMsgs}+${sanitizedTools}`);
    }
  }

  const register = options.systemRegister || SYSTEM_REGISTER;
  if (options.injectSystem !== false && !systemTextOf(body).includes(SYSTEM_REGISTER_HEAD)) {
    const index = findLastSystemInsertIndex(body.messages);
    if (index >= 0) {
      body.messages[index].content = appendText(body.messages[index].content, register);
      result.actions.push('system-register-appended');
    } else {
      body.messages.unshift({ role: 'system', content: register });
      result.actions.push('system-register-inserted');
    }
    result.changed = true;
  }

  if (options.teamHint) {
    result.teamTools = appendTeamHints(body);
    if (result.teamTools > 0) { result.changed = true; result.actions.push(`team-hint:${result.teamTools}`); }
  }

  const seed = String(options.seed == null ? SEED : options.seed);
  const last = body.messages[body.messages.length - 1];
  const lastRole = String(last && last.role || '');
  const isToolTurn = lastRole === 'tool' || (lastRole === 'assistant' && last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0);
  const marker = String(options.seedMarker || (seed === SEED ? SEED_HEAD : seed.slice(0, 40)));
  // seedPosition:
  // - 'first-user'（默认，零回撤缓存友好）：永远固定插在第一条 user 消息之前，跨 user 轮和 tool 轮永不搬家；
  // - 'last-user'（激进模式）：插在最新一条 user 消息之前。
  const seedPosition = String(options.seedPosition ?? 'first-user').toLowerCase();

  if (options.injectSeed !== false && seed) {
    const already = body.messages.some(message => marker && textOfContent(message.content).includes(marker));
    if (!already) {
      if (seedPosition === 'first-user') {
        const allowTurn = lastRole === 'user' || (isToolTurn && options.toolStepReseed !== false);
        const firstUserIdx = findFirstUserIndex(body.messages);
        if (allowTurn && firstUserIdx >= 0) {
          body.messages.splice(firstUserIdx, 0, seedMessage(seed, options));
          result.changed = true;
          result.seedInjected = true;
          result.actions.push(isToolTurn ? 'seed-first-user-reseed' : 'seed-before-task');
        }
      } else if (lastRole === 'user') {
        body.messages.splice(body.messages.length - 1, 0, seedMessage(seed, options));
        result.changed = true;
        result.seedInjected = true;
        result.actions.push('seed-before-task');
      } else if (isToolTurn && options.toolStepReseed !== false) {
        const lastUserIdx = findLastUserIndex(body.messages);
        if (lastUserIdx >= 0) {
          body.messages.splice(lastUserIdx, 0, seedMessage(seed, options));
          result.changed = true;
          result.seedInjected = true;
          result.actions.push('seed-before-task-reseed');
        }
      }
    }
  }

  // contentFill 在 toolStepAnchor 修改 reasoning_content 之前运行，避免 content 里重复出现两份 seed。
  if (options.injectSeed !== false && seed) {
    const filled = fillAssistantContent(body.messages, seed, options);
    if (filled > 0) {
      result.changed = true;
      result.contentFilled = filled;
      result.actions.push(`content-fill:${filled}`);
    }
  }

  if (options.injectSeed !== false && seed && options.toolStepAnchor === true && isToolTurn) {
    const index = findLastAssistantWithTools(body.messages);
    if (index >= 0) {
      const message = body.messages[index];
      const anchor = `${TOOL_STEP_ANCHOR}\n\n${seed}`;
      if (typeof message.reasoning_content === 'string') {
        if (!message.reasoning_content.includes(TOOL_STEP_ANCHOR)) {
          message.reasoning_content = message.reasoning_content
            ? `${message.reasoning_content}\n\n${anchor}` : anchor;
          result.changed = true;
          result.anchorInjected = true;
          result.actions.push('tool-step-anchor-reasoning');
        }
      } else if (message.content != null && !textOfContent(message.content).includes(TOOL_STEP_ANCHOR) && !textOfContent(message.content).includes(CONTINUE_WORK)) {
        message.content = appendText(message.content, anchor);
        result.changed = true;
        result.anchorInjected = true;
        result.actions.push('tool-step-anchor-content');
      } else if (typeof message.reasoning_content !== 'string') {
        message.reasoning_content = anchor;
        result.changed = true;
        result.anchorInjected = true;
        result.actions.push('tool-step-anchor-reasoning');
      }
    }
  }

  if (options.injectSeed !== false && isToolTurn && options.nearestGuidance && options.nearestGuidance !== 'off') {
    if (applyNearestGuidance(body.messages, options)) {
      result.changed = true;
      result.actions.push('nearest-guidance');
    }
  }

  return result;
}

function responsesContentText(content) {
  return textOfContent(content);
}

function appendResponsesText(content, text) {
  if (typeof content === 'string') return `${content}\n\n${text}`;
  if (Array.isArray(content)) return [...content, { type: 'input_text', text: `\n\n${text}` }];
  return [{ type: 'input_text', text }];
}

/**
 * OpenAI Responses API 注入。input 可以是字符串或消息项数组。
 * 新的 user task 前插入 assistant seed；工具输出前只做锚定，不新增消息。
 */
function injectResponses(body, options = {}) {
  const result = { changed: false, actions: [], seedInjected: false, anchorInjected: false, teamTools: 0 };
  if (!body || typeof body !== 'object') return result;

  const register = options.systemRegister || SYSTEM_REGISTER;
  if (options.injectSystem !== false) {
    const current = String(body.instructions || '');
    if (!current.includes(SYSTEM_REGISTER_HEAD)) {
      body.instructions = current ? `${current}\n\n${register}` : register;
      result.changed = true;
      result.actions.push('system-register-instructions');
    }
  }

  if (options.teamHint) {
    result.teamTools = appendTeamHints(body);
    if (result.teamTools > 0) { result.changed = true; result.actions.push(`team-hint:${result.teamTools}`); }
  }

  const seed = String(options.seed == null ? SEED : options.seed);
  if (typeof body.input === 'string') {
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
  }
  if (!Array.isArray(body.input) || !seed) return result;

  let lastUser = -1;
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    if (body.input[index] && body.input[index].role === 'user') { lastUser = index; break; }
  }
  const last = body.input[body.input.length - 1];
  const lastIsUser = lastUser === body.input.length - 1;

  if (options.injectSeed !== false && lastIsUser) {
    const marker = String(options.seedMarker || (seed === SEED ? SEED_HEAD : seed.slice(0, 40)));
    const already = body.input.some(item => marker && responsesContentText(item.content).includes(marker));
    if (!already) {
      body.input.splice(lastUser, 0, {
        type: 'message', role: 'assistant', content: [{ type: 'input_text', text: seed }]
      });
      result.changed = true;
      result.seedInjected = true;
      result.actions.push('seed-before-task');
    }
  } else if (options.injectSeed !== false && !lastIsUser && options.toolStepAnchor !== false) {
    for (let index = body.input.length - 1; index >= 0; index -= 1) {
      const item = body.input[index];
      if (item && item.role === 'assistant' && item.type === 'message') {
        const current = responsesContentText(item.content);
        if (!current.includes(TOOL_STEP_ANCHOR)) {
          item.content = appendResponsesText(item.content, `${TOOL_STEP_ANCHOR}\n\n${seed}`);
          result.changed = true;
          result.anchorInjected = true;
          result.actions.push('tool-step-anchor');
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Anthropic Messages API 注入。工具结果必须紧跟在 tool_use 之后，
 * 因此含 tool_result 的 user 消息只锚定上一条 assistant，不插 seed。
 */
function injectAnthropic(body, options = {}) {
  const result = { changed: false, actions: [], seedInjected: false, anchorInjected: false, teamTools: 0 };
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return result;

  const register = options.systemRegister || SYSTEM_REGISTER;
  if (options.injectSystem !== false && !systemTextOf(body).includes(SYSTEM_REGISTER_HEAD)) {
    if (typeof body.system === 'string') body.system = `${body.system}\n\n${register}`;
    else if (Array.isArray(body.system)) body.system = [...body.system, { type: 'text', text: register }];
    else body.system = register;
    result.changed = true;
    result.actions.push('system-register');
  }

  if (options.teamHint) {
    result.teamTools = appendTeamHints(body);
    if (result.teamTools > 0) { result.changed = true; result.actions.push(`team-hint:${result.teamTools}`); }
  }

  const seed = String(options.seed == null ? SEED : options.seed);
  if (!seed) return result;
  const last = body.messages[body.messages.length - 1];
  if (!last || last.role !== 'user') return result;

  const parts = Array.isArray(last.content) ? last.content : [];
  const hasToolResult = parts.some(part => part && part.type === 'tool_result');
  if (hasToolResult) {
    if (options.injectSeed !== false && options.toolStepAnchor !== false) {
      for (let index = body.messages.length - 2; index >= 0; index -= 1) {
        const message = body.messages[index];
        if (message && message.role === 'assistant') {
          const anchor = `${TOOL_STEP_ANCHOR}\n\n${seed}`;
          if (Array.isArray(message.content)) {
            const text = textOfContent(message.content);
            if (!text.includes(TOOL_STEP_ANCHOR)) {
              message.content = [...message.content, { type: 'text', text: `\n\n${anchor}` }];
              result.changed = true;
              result.anchorInjected = true;
              result.actions.push('tool-step-anchor');
            }
          } else if (typeof message.content === 'string') {
            message.content = `${message.content}\n\n${anchor}`;
            result.changed = true;
            result.anchorInjected = true;
            result.actions.push('tool-step-anchor');
          }
          break;
        }
      }
    }
  } else if (options.injectSeed !== false) {
    const marker = String(options.seedMarker || (seed === SEED ? SEED_HEAD : seed.slice(0, 40)));
    const already = body.messages.some(message => marker && textOfContent(message.content).includes(marker));
    if (!already) {
      body.messages.splice(body.messages.length - 1, 0, {
        role: 'assistant', content: [{ type: 'text', text: seed }]
      });
      result.changed = true;
      result.seedInjected = true;
      result.actions.push('seed-before-task');
    }
  }

  return result;
}

function applyCompactionRegister(body) {
  const result = { changed: false, actions: [] };
  if (!body || typeof body !== 'object') return result;
  const marker = COMPACTION_REGISTER_HEAD;
  if (typeof body.input === 'string') {
    if (!body.input.includes(marker)) { body.input = `${body.input}\n\n${COMPACTION_REGISTER}`; result.changed = true; }
    result.actions.push('compaction-register');
    return result;
  }
  if (Array.isArray(body.input) && body.input.length) {
    const last = body.input[body.input.length - 1];
    if (last && !textOfContent(last.content).includes(marker)) {
      last.content = appendResponsesText(last.content, COMPACTION_REGISTER);
      result.changed = true;
    }
    result.actions.push('compaction-register');
    return result;
  }
  if (Array.isArray(body.messages) && body.messages.length) {
    const last = body.messages[body.messages.length - 1];
    if (last && !textOfContent(last.content).includes(marker)) {
      last.content = appendText(last.content, COMPACTION_REGISTER);
      result.changed = true;
    }
    result.actions.push('compaction-register');
    return result;
  }
  if (typeof body.system === 'string' && !body.system.includes(marker)) {
    body.system = `${body.system}\n\n${COMPACTION_REGISTER}`;
    result.changed = true;
    result.actions.push('compaction-register');
  }
  return result;
}

function applyRequest(body, pathname, options = {}) {
  const path = String(pathname || '');
  if (/\/chat\/completions\/?$/i.test(path)) return injectChat(body, options);
  if (/\/responses\/?$/i.test(path)) return injectResponses(body, options);
  if (/\/messages\/?$/i.test(path)) return injectAnthropic(body, options);
  return { changed: false, actions: ['unsupported-path'], seedInjected: false, anchorInjected: false, teamTools: 0 };
}

function detectLanguage(task) {
  return /[\u3400-\u9fff]/.test(String(task || '')) ? 'zh' : 'en';
}

function clip(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 现场组合一条 WeNeed seed。用于 seedMode=task，也可作为手动模式的工具。
 * 英文情态词保持不变，与上游寄存器一致；句子内容跟随任务语言。
 */
function composeSeed(input = {}) {
  const task = clip(input.task || input.goal || '', 600);
  if (!task) throw new Error('缺少 task 或 goal');
  let language = String(input.language || 'auto').toLowerCase();
  if (!['zh', 'en', 'auto'].includes(language)) language = 'auto';
  if (language === 'auto') language = detectLanguage(task);
  const mode = ['standard', 'goal', 'team'].includes(String(input.mode)) ? String(input.mode) : 'standard';
  const goal = clip(input.goal || task, 320);
  const constraints = (Array.isArray(input.constraints) ? input.constraints : []).map(item => clip(item, 200)).filter(Boolean);
  const options = (Array.isArray(input.options) ? input.options : []).map(item => clip(item, 200)).filter(Boolean);
  const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map(item => clip(item, 200)).filter(Boolean);
  const nextAction = clip(input.nextAction || (language === 'zh' ? '先做最小可验证的一步，再按证据扩展' : 'take the smallest verifiable step, then expand from evidence'), 240);

  const sentences = [];
  if (language === 'zh') {
    sentences.push(`We need 先复述本次任务的目标与交付物：${goal}。`);
    sentences.push('Need 保留用户原话、路径、命令、数值和已有证据不变。');
    sentences.push('Should 检查请求语言、范围、可用工具与未观察信息；缺失证据不得编造。');
    if (constraints.length) sentences.push(`Must 守住这些硬约束：${constraints.join('；')}。`);
    if (evidence.length) sentences.push(`Should 以已有证据为准：${evidence.join('；')}。`);
    sentences.push('Could 取 A：先读取实际输入或跑最小验证；或 B：用已有证据直接作答。');
    if (options.length) sentences.push(`Could 备选路径：${options.join('；')}。`);
    sentences.push('Must 对比 A/B 的证据成本、工具限制与范围风险。');
    sentences.push('Need 选择代价更低的正确路径，先行动，再对照原始请求验证。');
    if (mode === 'goal') sentences.push('Need 把目标与验收证据当作唯一事实源，不把过程猜测写进结论。');
    if (mode === 'team') sentences.push('We need 每个外发给 teammate、sub-agent 或 workflow 的 prompt 自包含，写清目标、下一步、约束和期望证据。');
    sentences.push(`Let's 下一步：${nextAction}。`);
    const seed = sentences.join(' ');
    const max = Math.max(200, Math.min(4000, Number(input.maxChars) || 1600));
    return { seed: seed.length > max ? `${seed.slice(0, max - 1)}…` : seed, language, mode, chars: Math.min(seed.length, max) };
  }

  sentences.push(`We need first restate the goal and deliverable: ${goal}.`);
  sentences.push('Need preserve the user\'s wording, paths, commands, numbers, and existing evidence.');
  sentences.push('Should check the request language, scope, available tools, and unobserved facts; never invent missing evidence.');
  if (constraints.length) sentences.push(`Must hold these hard constraints: ${constraints.join('; ')}.`);
  if (evidence.length) sentences.push(`Should ground the plan in existing evidence: ${evidence.join('; ')}.`);
  sentences.push('Could take A: inspect the actual inputs or run the smallest verification; or B: answer from evidence already present.');
  if (options.length) sentences.push(`Could consider these alternatives: ${options.join('; ')}.`);
  sentences.push('Must compare A and B for evidence cost, tool limits, and scope risk.');
  sentences.push('Need choose the cheaper correct path, act, then verify against the original request.');
  if (mode === 'goal') sentences.push('Need treat the goal and its acceptance evidence as the only source of truth, not process guesses.');
  if (mode === 'team') sentences.push('We need every outgoing prompt to a teammate, sub-agent, or workflow agent to be self-contained: state the target, next action, constraints, and expected evidence.');
  sentences.push(`Let's next: ${nextAction}.`);
  const seed = sentences.join(' ');
  const max = Math.max(200, Math.min(4000, Number(input.maxChars) || 1600));
  return { seed: seed.length > max ? `${seed.slice(0, max - 1)}…` : seed, language, mode, chars: Math.min(seed.length, max) };
}

const ANTI_PATTERNS = [
  ['the user wants', '改为 We need / Need 开头，直接陈述下一步。'],
  ['user wants', '改为 We need / Need 开头，直接陈述下一步。'],
  ['requester wants', '不要描述请求者想什么，直接写计划。'],
  ['i will ', '避免第一人称未来承诺，用 Need / Should / Let\'s。'],
  ['i\'ll ', '避免第一人称未来承诺，用 Need / Should / Let\'s。'],
  ['i need to', '用 Need 替代自我指涉的 I need to。'],
  ['i am going to', '避免第一人称未来承诺，改用 Need。'],
  ['let me ', '用 Let\'s 或直接祈使句替代 let me。'],
  ['用户想要', '不要描述用户想要什么，直接写 Need 计划。'],
  ['用户希望', '不要描述用户希望什么，直接写 Need 计划。'],
  ['我将', '避免第一人称未来承诺，用 Need / Should / Let\'s。'],
  ['我会', '避免第一人称未来承诺，用 Need / Should / Let\'s。'],
  ['让我', '用 Let\'s 或直接祈使句替代“让我”。']
];

function auditRegister(text, language = 'auto') {
  const value = String(text || '');
  if (!value.trim()) return { ok: false, error: '缺少要审计的文本' };
  const counts = {};
  for (const word of ['need', 'should', 'could', 'can', 'must', 'let']) {
    counts[word] = (value.match(new RegExp(`\\b${word}\\b`, 'gi')) || []).length;
  }
  counts.collective = (value.match(/\b(?:We need|We should|We can|We could|We must|Let's)\b/gi) || []).length;
  const distinct = ['need', 'should', 'could', 'must', 'let'].filter(word => counts[word] > 0).length;
  const trimmed = value.trim();
  const opening = trimmed.slice(0, 40);
  const openingOk = /^(?:We need|Need|Should|We should|Let's|We can|We could|We must)\b/i.test(trimmed);
  const issues = [];
  if (!openingOk) issues.push('开头不是 We need / Need / Should；先写集体计划，不要写请求者描述。');
  if (distinct < 3) issues.push(`只用了 ${distinct} 类情态词；至少混用 Need / Should / Could / Must / Let's 中的三类。`);
  if (!counts.must) issues.push('没有 Must：硬约束、不可编造项和范围边界需要一条 Must。');
  const lower = value.toLowerCase();
  for (const [pattern, advice] of ANTI_PATTERNS) {
    if (lower.includes(pattern)) issues.push(`出现「${pattern}」：${advice}`);
  }
  const suggestions = issues.length
    ? ['把首句改成 We need … 或 Need …。', '保留用户原话、路径、数字和证据；未知信息先验证。', '用 Let\'s 收尾下一步动作。']
    : ['寄存器覆盖足够；保持句子短、动作具体、证据可核对。'];
  const score = Math.max(0, 100 - issues.length * 12);
  return {
    ok: true,
    language: language === 'auto' ? detectLanguage(value) : language,
    counts,
    distinct,
    opening,
    openingOk,
    score,
    issues,
    suggestions
  };
}

module.exports = {
  SEED,
  SEED_HEAD,
  SYSTEM_REGISTER,
  SYSTEM_REGISTER_HEAD,
  NEAREST_GUIDANCE,
  CONTINUE_WORK,
  TOOL_STEP_ANCHOR,
  TEAM_REGISTER_HINT,
  COMPACTION_REGISTER_HEAD,
  COMPACTION_REGISTER,
  TOOL_DESC_GUIDANCE,
  TEAM_TOOL_PATTERN,
  textOfContent,
  appendText,
  matchesTarget,
  looksLikeCompaction,
  appendTeamHints,
  sanitizeProgramText,
  sanitizeProgramMessages,
  sanitizeToolDefinitions,
  fillAssistantContent,
  applyNearestGuidance,
  injectChat,
  injectResponses,
  injectAnthropic,
  applyCompactionRegister,
  applyRequest,
  composeSeed,
  auditRegister,
  detectLanguage
};