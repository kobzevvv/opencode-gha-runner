import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AnswerSource } from '../contracts.js';

export type AgentOutputFormat = 'json' | 'plain';

export function agentOutputFormat(args: readonly string[]): AgentOutputFormat {
  let format = 'default';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--format') format = args[++index] ?? 'default';
    else if (argument.startsWith('--format=')) format = argument.slice('--format='.length);
  }
  return format === 'json' ? 'json' : 'plain';
}

export function extractAssistantText(stdout: string): string | undefined {
  const turns = new Map<string, { parts: Map<string, string>; finished: boolean }>();
  let session: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { if (line.trimStart().startsWith('{')) return undefined; else continue; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue;
    if (!['step_start', 'step_finish', 'text', 'tool_use'].includes(String(frame.type))) continue;
    const part = frame.part as Record<string, unknown> | undefined;
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    if (typeof frame.sessionID !== 'string' || typeof part.messageID !== 'string' || !part.messageID) continue;
    session ??= frame.sessionID;
    if (frame.sessionID !== session || (part.sessionID !== undefined && part.sessionID !== session)) continue;
    if ((frame.role !== undefined && frame.role !== 'assistant') || (part.role !== undefined && part.role !== 'assistant')) continue;
    let turn = turns.get(part.messageID);
    if (!turn) { turn = { parts: new Map(), finished: false }; turns.set(part.messageID, turn); }
    if (frame.type === 'step_finish' && part.type === 'step-finish') turn.finished = part.reason === 'stop';
    const time = part.time as { end?: unknown } | undefined;
    if (frame.type === 'text' && part.type === 'text' && typeof part.id === 'string' && typeof part.text === 'string' && typeof time?.end === 'number' && time.end > 0) {
      turn.parts.set(part.id, part.text);
    }
  }
  const finalTurn = [...turns.values()].at(-1);
  if (!finalTurn?.finished) return undefined;
  const text = [...finalTurn.parts.values()].join('\n').trim();
  return text || undefined;
}

export function extractAnswer(workspace: string, stdout: string, format: AgentOutputFormat): { text?: string; source: AnswerSource } {
  for (const candidate of ['.agent/answer.txt', 'answer.txt']) {
    try {
      const absolute = realpathSync(path.resolve(workspace, candidate));
      const relative = path.relative(realpathSync(workspace), absolute);
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || !statSync(absolute).isFile()) continue;
      const text = readFileSync(absolute, 'utf8').trim();
      if (text) return { text, source: 'agent_file' };
    } catch { continue; }
  }
  const jsonFrames = stdout.split(/\r?\n/).some((line) => /"type"\s*:\s*"(?:text|tool_use|step_start|step_finish|reasoning)"/.test(line) && /"part"\s*:/.test(line));
  const text = format === 'json' || jsonFrames ? extractAssistantText(stdout) : stdout.trim() || undefined;
  return text ? { text, source: 'engine_stdout' } : { source: null };
}
