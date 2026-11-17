import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionMessage, SessionRateLimit } from 'claude-code'

import type { AgentMeta, Bar, ConsoleRow, ContextFill, Task, Weekly } from '../types'

const PANE = 'side-monitor'
const BAR_MIN_INTERVAL_MS = 180_000
const POLL_MS = 3_000
const ENDED_LINGER_MS = 10_000
// Bash's own timeout tops out at 10 minutes.
const FOREGROUND_MAX_MS = 11 * 60_000
const LOST_AFTER_MISSES = 3
const BACKFILL_ROWS = 200
const TAIL_LINES = 1
const EXPANDED_LINES = 300
const TRACK = '#303030'
const COMPACT_AT_PERCENT = 85
const HEAT_FULL_PERCENT = 75
const WEEK_LIGHT = [0xcf, 0xe8, 0xff]
const WEEK_DARK = [0x0a, 0x2a, 0x6b]
const HEAT_STOPS = [[0x90, 0xe0, 0x90], [0xff, 0xa5, 0x00], [0xff, 0x00, 0x00]]
const COMPACT_LABEL = 'Cmpct now'
const QUEUED_LABEL = 'Cmpct next'
// The button stands out from the bar beneath it by this much per channel, filled or not.
const BUTTON_LIFT = 0x1a
// Nerd Font chevrons: nf-fa-chevron_down expands a section, nf-fa-chevron_up collapses it.
const EXPAND_GLYPH = ''
const COLLAPSE_GLYPH = ''
const COMPACT_RETRY_MS = 2_000
// Label ink on the grey track; also what a hovered pill's caps turn, as its body inverts to it.
const LIGHT_INK = '#d0d0d0'
const GOOD_END = new Set(['done', 'completed'])
const QUIET_END = new Set(['ended', 'lost', 'interrupted'])
const WEEK_YELLOW = '#f5c400'
const COMPACT_TRIES = 5

const baseline = atom({ plugin: 'side-monitor', key: 'baseline' } as const, null)
const bar = atom({ plugin: 'side-monitor', key: 'bar' } as const, null)
const barShownAt = atom({ plugin: 'side-monitor', key: 'barShownAt' } as const, 0)
const agents = atom({ plugin: 'side-monitor', key: 'agents' } as const, [])
const shells = atom({ plugin: 'side-monitor', key: 'shells' } as const, [])
const agentMeta = atom({ plugin: 'side-monitor', key: 'agentMeta' } as const, {})
const context = atom({ plugin: 'side-monitor', key: 'context' } as const, null)
const expanded = atom({ plugin: 'side-monitor', key: 'expanded' } as const, null)
const mode = atom({ plugin: 'side-monitor', key: 'mode' } as const, 'default')
const compactQueued = atom({ plugin: 'side-monitor', key: 'compactQueued' } as const, false)
const consoles = atom({ plugin: 'side-monitor', key: 'consoles' } as const, {})

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const ENDED_AGENT = new Set(['completed', 'failed', 'killed'])

export const tailOf = (text: string, lines = TAIL_LINES): string =>
  text
    .replace(ANSI, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(-lines)
    .join('\n')

const RESULT_LINES = 4
const CONSOLE_ROWS = 200
const LABEL_KEYS = ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'prompt']
// A tool.call event carries these beside the tool's own input.
const ENVELOPE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])

/** The argument a console row shows for a tool call: its most telling string input, first line only. */
export const callLabel = (input: Record<string, unknown>): string => {
  const named = LABEL_KEYS.map(key => input[key]).find(v => typeof v === 'string' && v.length > 0)
  const any = named ?? Object.entries(input).find(([key, v]) => !ENVELOPE_KEYS.has(key) && typeof v === 'string')?.[1]
  return typeof any === 'string' ? (any.split('\n')[0] ?? '').slice(0, 80) : ''
}

/** An agent's transcript as console rows: its text and each tool call with its result. */
export const consoleOf = (messages: Pick<SessionMessage, 'role' | 'text' | 'toolUses'>[]): ConsoleRow[] => {
  const rows: ConsoleRow[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (message.text) rows.push({ kind: 'text', text: tailOf(message.text, TEXT_LINES) })
    for (const use of message.toolUses) {
      const head = use.text === undefined ? {} : resultHead(use.text)
      rows.push({ kind: 'call', id: use.tool_use_id, tool: use.tool, label: callLabel(use.input), ...head })
    }
  }
  return rows
}

const TEXT_LINES = 40

/** A result as a console keeps it: its first lines, and how many more it had. */
export const resultHead = (text: string): { result: string; more?: number } => {
  const lines = tailOf(text, Infinity).split('\n')
  return lines.length > RESULT_LINES
    ? { result: lines.slice(0, RESULT_LINES).join('\n'), more: lines.length - RESULT_LINES }
    : { result: lines.join('\n') }
}

const callHead = (row: Extract<ConsoleRow, { kind: 'call' }>) => `${row.isError ? '✗' : '●'} ${row.tool}(${row.label})`

/** Console rows as text: the text, each call, and the first lines of each result. */
export const consoleText = (rows: ConsoleRow[], lines = EXPANDED_LINES): string => {
  const out: string[] = []
  for (const row of rows) {
    if (row.kind === 'text') {
      const text = tailOf(row.text, lines)
      if (text) out.push(...text.split('\n'))
      continue
    }
    out.push(callHead(row))
    const result = row.result === undefined ? ['running…'] : tailOf(row.result, Infinity).split('\n')
    const shown = result[0] ? result.slice(0, RESULT_LINES) : ['(no output)']
    const more = (row.more ?? 0) + Math.max(0, result.length - RESULT_LINES)
    if (more > 0) shown.push(`… +${more} lines`)
    shown.forEach((line, i) => out.push(`${i === 0 ? '  ⎿ ' : '    '}${line}`))
  }
  return out.slice(-lines).join('\n')
}

/** An agent's transcript as console text. */
export const transcriptLines = (
  messages: Pick<SessionMessage, 'role' | 'text' | 'toolUses'>[],
  lines = EXPANDED_LINES,
): string => consoleText(consoleOf(messages), lines)

/** What the agent does now: its newest call, or the last line of its newest text. */
export const nowLine = (rows: ConsoleRow[]): string => {
  const last = rows.at(-1)
  if (!last) return ''
  return last.kind === 'call' ? callHead(last) : tailOf(last.text)
}

/** The collapsed rows of an agent: the engine's progress summary when it has one, then what it does now. */
export const agentTail = (summary: string | undefined, description: string, rows: ConsoleRow[]): string => {
  const said = summary && summary !== description ? tailOf(summary) : ''
  return [said, nowLine(rows)].filter(Boolean).join('\n')
}

/** What a finished tool call answered, as text. */
export const resultText = (ran: { deny?: string; text?: string; result?: unknown; isError?: true } | undefined): string => {
  if (!ran) return 'interrupted'
  if (ran.deny) return `denied: ${ran.deny}`
  if (ran.text !== undefined) return ran.text
  const result = ran.result as { stdout?: string; stderr?: string } | string | undefined
  if (typeof result === 'string') return result
  if (result && (result.stdout !== undefined || result.stderr !== undefined)) {
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  }
  return ''
}

/** Reads the engine's trailer on a background shell's output file. */
export const shellStatus = (tail: string): string | undefined => {
  const last = tail.split('\n').pop() ?? ''
  const exit = /^\[exited with code (\d+)\]$/.exec(last)
  if (exit) return exit[1] === '0' ? 'done' : `exit ${exit[1]}`
  if (last === '[killed]') return 'killed'
  return undefined
}

const weeklyOf = (limits: SessionRateLimit[]): Weekly | undefined => {
  const week = limits.find(limit => limit.kind === 'seven_day')
  return week && { percentUsed: week.percentUsed, resetsAt: week.resetsAt }
}

const compact = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const trimZero = (text: string): string => text.replace(/\.0(?=[km%]?$)/, '')

export const shortTokens = (n: number): string =>
  n >= 1_000_000 ? `${trimZero((n / 1_000_000).toFixed(1))}m` : trimZero(compact(n))

export const shortPercent = (n: number): string => `${trimZero(n.toFixed(1))}%`

/** Splits a label into runs, each run on the background of the bar cells beneath it. */
export const overlay = (label: string, width: number, fills: { cells: number; color: string }[]) => {
  const text = label.length >= width ? label.slice(0, width) : label.padEnd(width)
  const runs: { text: string; background?: string }[] = []
  let start = 0
  for (const fill of [...fills, { cells: width, color: '' }]) {
    const end = Math.min(width, start + Math.max(0, fill.cells))
    if (end > start) runs.push({ text: text.slice(start, end), background: fill.color || undefined })
    start = end
  }
  return runs
}

/** Colors each filled cell along light green, orange, red from the first cell; pure red from 75%. */
export const heatColors = (filled: number, width: number, window: number): string[] => {
  const full = (HEAT_FULL_PERCENT / 100) * window
  return Array.from({ length: filled }, (_, i) => {
    const t = Math.min(1, (((i + 1) / width) * window) / full) * (HEAT_STOPS.length - 1)
    const from = HEAT_STOPS[Math.min(Math.floor(t), HEAT_STOPS.length - 2)]!
    const to = HEAT_STOPS[Math.min(Math.floor(t), HEAT_STOPS.length - 2) + 1]!
    const k = t - Math.min(Math.floor(t), HEAT_STOPS.length - 2)
    return `#${from.map((c, n) => Math.round(c + (to[n]! - c) * k).toString(16).padStart(2, '0')).join('')}`
  })
}

/** The weekly bar's cells: earlier use in very light to dark blue across the bar, this session's solid yellow. */
export const weekColors = (used: number, mine: number, width: number): string[] =>
  Array.from({ length: used }, (_, i) => {
    if (i >= used - mine) return 'yellow'
    const k = width > 1 ? i / (width - 1) : 0
    return `#${WEEK_LIGHT.map((c, n) => Math.round(c + (WEEK_DARK[n]! - c) * k).toString(16).padStart(2, '0')).join('')}`
  })

const hex = (rgb: number[]) => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`

/** The weekly bar on a graphical surface: earlier use light to dark blue across the bar, this session yellow. */
export const weekSvg = (percentUsed: number, spent: number): string => {
  const used = Math.min(100, Math.max(0, percentUsed))
  const mine = Math.min(used, Math.max(0, spent))
  const r = (n: number) => Math.round(n * 100) / 100
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 6" preserveAspectRatio="none" width="100%" height="8">' +
    '<defs><linearGradient id="w" gradientUnits="userSpaceOnUse" x1="0" x2="100">' +
    `<stop offset="0" stop-color="${hex(WEEK_LIGHT)}"/><stop offset="1" stop-color="${hex(WEEK_DARK)}"/></linearGradient>` +
    '<clipPath id="c"><rect width="100" height="6" rx="3"/></clipPath></defs>' +
    '<g clip-path="url(#c)"><rect width="100" height="6" fill="#8080802e"/>' +
    `<rect width="${r(used - mine)}" height="6" fill="url(#w)"/>` +
    `<rect x="${r(used - mine)}" width="${r(mine)}" height="6" fill="${WEEK_YELLOW}"/></g></svg>`
  )
}

/** Black text on a light cell, white on a dark one. */
export const inkOn = (color: string): string => {
  if (!color.startsWith('#')) return 'black'
  const [r, g, b] = [1, 3, 5].map(n => parseInt(color.slice(n, n + 2), 16))
  return 0.299 * r! + 0.587 * g! + 0.114 * b! < 128 ? 'white' : 'black'
}

/** Lightens a bar color by BUTTON_LIFT per channel. */
export const lift = (color: string): string => {
  const hex = color.replace('#', '')
  return `#${[0, 2, 4]
    .map(i => Math.min(255, parseInt(hex.slice(i, i + 2), 16) + BUTTON_LIFT).toString(16).padStart(2, '0'))
    .join('')}`
}

const contextOf = (usage: SessionContextUsage): ContextFill => ({
  tokens: usage.tokens,
  window: usage.window,
  percent: usage.percent ?? (usage.tokens !== undefined && usage.window > 0 ? (usage.tokens / usage.window) * 100 : undefined),
})

/** Stamps when each entry ended and drops those ended more than ENDED_LINGER_MS ago. */
const settle = (list: Task[], now: number): Task[] =>
  list
    .map(task => (task.isLive || task.endedAt !== undefined ? task : { ...task, endedAt: now }))
    .filter(task => task.isLive || now - (task.endedAt ?? now) < ENDED_LINGER_MS)

const MODE_HINT = '(shift+tab to cycle)'
const MODES: [mode: string, word: string, label: RegExp][] = [
  ['default', 'manual', /\bmanual mode on\b/],
  ['acceptEdits', 'edits', /\baccept edits on\b/],
  ['plan', 'plan', /\bplan mode on\b/],
  ['auto', 'auto', /\bauto mode on\b/],
  ['bypassPermissions', 'bypass', /\bbypass permissions on\b/],
  ['dontAsk', 'dontask', /\bdon't ask mode on\b/],
]
// Segments at rest step through a grey gradient left to right; the active one is green.
const GREYS = ['#303030', '#444444', '#585858', '#6c6c6c', '#808080']
const ACTIVE = '#00d75f'
const ARROW = '\ue0b0'
// nf-ple-right_hard_divider_inverse: a block notched by an arrow tip, the tail end of a segment.
const ARROW_TAIL = '\ue0d7'
// Section titles wear the shade the "edits" segment has when inactive.
const TITLE_SHADE = GREYS[1]!
const CYCLE = new Set(['default', 'acceptEdits', 'plan', 'auto'])

// shift+tab's order; a mode missing here has an unknown successor, and a hook event corrects it.
const NEXT: Record<string, string> = { default: 'acceptEdits', acceptEdits: 'plan', plan: 'auto', auto: 'default' }

/** The mode shift+tab entered: for one render after the press, the footer names the mode it left. */
export const modeOf = (hint: string): string | undefined => {
  const left = MODES.find(([, , label]) => label.test(hint))?.[0]
  return left && NEXT[left]
}

async function setMode($: EngineInterface, next: string) {
  if ((await read($, mode)) !== next) await update($, mode, () => next)
}

/** The footer hint without the agent count and the mode's cycle hint. */
export const footerHint = (hint: string): string => {
  const parts = hint
    .split(' · ')
    .map(part => part.replace(MODE_HINT, '').trim())
    .filter(part => part.length > 0)
  const hasAgents = parts.some(part => /^← \d+ agents?$/.test(part))
  const kept = parts.filter(part => !/^← \d+ agents?$/.test(part) && !(hasAgents && part === '↓ to manage'))
  const hasOtherTasks = kept.some(part => /^\d+ (shells?|tasks?|monitors?|workflows?)$/.test(part))
  if (hasAgents && hasOtherTasks) kept.push('↓ to manage')
  return kept.join(' · ')
}

let poll: { cancel: () => void } | undefined
let barTimer: { cancel: () => void } | undefined
let pending: Bar | undefined
let isTicking = false

async function publishBar($: EngineInterface) {
  barTimer?.cancel()
  barTimer = undefined
  if (!pending) return
  const next = pending
  pending = undefined
  const now = await $.clock.now()
  await update($, bar, () => next)
  await update($, barShownAt, () => now)
}

/** Takes every weekly reading, but shows one at most every 180 s. */
async function onWeekly($: EngineInterface, week: Weekly) {
  let base = await read($, baseline)
  if (!base) {
    const last = (await $.store.get('lastWeekly')) as Weekly | undefined
    const isSameWindow =
      last && week.resetsAt !== undefined && last.resetsAt === week.resetsAt && last.percentUsed <= week.percentUsed
    base = isSameWindow ? last : week
    await update($, baseline, () => base)
  } else if (week.percentUsed < base.percentUsed) {
    // The weekly window reset: everything used since belongs to this session.
    base = { percentUsed: 0, resetsAt: week.resetsAt }
    await update($, baseline, () => base)
  }
  await $.store.set('lastWeekly', week)

  pending = { baseline: base.percentUsed, current: week.percentUsed, resetsAt: week.resetsAt }
  const wait = (await read($, barShownAt)) + BAR_MIN_INTERVAL_MS - (await $.clock.now())
  if (wait <= 0) return publishBar($)
  barTimer ??= $.clock.after(wait, () => void publishBar($))
}

// Output files sit under the process's first session id, which /clear does not carry; search every session.
const TASKS_ROOT = '"${CLAUDE_CODE_TMPDIR:-${TMPDIR:-/tmp}}"/claude-$(id -u)'

/** Finds a background task's output file by its id, which is unique across sessions. */
async function findOutput($: EngineInterface, taskId: string): Promise<string | undefined> {
  const found = await $.process.run([
    'sh',
    '-c',
    `ls -t ${TASKS_ROOT}/*/*/tasks/"$1".output 2>/dev/null | head -n1`,
    'sh',
    taskId,
  ])
  return found.stdout.trim() || undefined
}

async function readShell($: EngineInterface, shell: Task): Promise<Task> {
  const path = shell.outputPath ?? (shell.id.startsWith('bg:') ? await findOutput($, shell.id.slice(3)) : undefined)
  const out = path ? await $.process.run(['tail', '-c', '32000', path]) : undefined
  if (!out || out.exitCode !== 0) {
    // A background shell whose output file stays gone has ended without its trailer.
    const misses = (shell.misses ?? 0) + 1
    const isLost = shell.id.startsWith('bg:') && misses >= LOST_AFTER_MISSES
    return { ...shell, outputPath: path, misses, tail: shell.tail || 'output file not found', ...(isLost && { isLive: false, status: 'lost' }) }
  }
  const all = tailOf(out.stdout, EXPANDED_LINES + 1)
  const ended = shellStatus(all)
  const lines = ended ? all.split('\n').slice(0, -1).join('\n') : all
  return {
    ...shell,
    outputPath: path,
    misses: 0,
    status: ended ?? 'running',
    isLive: !ended,
    tail: tailOf(lines),
    lines,
  }
}

/** Reads one agent's transcript for an agent whose console the panel has no events of. */
async function backfill($: EngineInterface, agentId: string): Promise<{ rows: ConsoleRow[] } | { note: string }> {
  const read = await $.session.messages({ agentId, last: BACKFILL_ROWS })
  if (Array.isArray(read)) return { rows: consoleOf(read) }
  const deny = (read as { deny?: string }).deny
  return { note: `transcript unavailable${deny ? `: ${deny}` : ''}` }
}

async function readAgents($: EngineInterface, now: number): Promise<{ rows: Task[]; ids: Set<string> }> {
  const known = await read($, agents)
  const all = await $.agent.list()
  const byConsole = await read($, consoles)
  const filled: Record<string, ConsoleRow[]> = {}
  // An ended agent shows only if the panel saw it running and it ended moments ago.
  const list = all.filter(agent => {
    if (!ENDED_AGENT.has(agent.status)) return true
    const before = known.find(t => t.id === agent.id)
    return before !== undefined && (before.endedAt === undefined || now - before.endedAt < ENDED_LINGER_MS)
  })
  const rows = await Promise.all(
    list.map(async (agent): Promise<Task> => {
      const isLive = !ENDED_AGENT.has(agent.status)
      const before = known.find(task => task.id === agent.id)
      let console = byConsole[agent.id] ?? []
      let note: string | undefined
      // The panel's events fill the console; an agent it saw none of is read from its transcript.
      if (console.length === 0 && (isLive || before?.isLive !== false)) {
        const got = await backfill($, agent.id).catch(() => ({ note: 'transcript unavailable' }))
        if ('rows' in got) {
          console = got.rows
          if (console.length > 0) filled[agent.id] = console.slice(-CONSOLE_ROWS)
        } else note = got.note
      }
      const tail = agentTail(agent.label, agent.description, console) || note || before?.tail || 'starting…'
      return {
        id: agent.id,
        // The divider shows the type; a name the engine derived from it would repeat it.
        title: agent.description || (agent.name !== agent.type ? agent.name : undefined) || '',
        type: agent.type,
        status: agent.status,
        tail,
        lines: consoleText(console) || note || tail,
        isLive,
        startedAt: agent.startTime,
        endedAt: before?.endedAt,
      }
    }),
  )
  if (Object.keys(filled).length > 0) {
    await update($, consoles, current => {
      const next = { ...current }
      // Events that came in while the transcript was read win.
      for (const [id, rows] of Object.entries(filled)) if (!next[id]?.length) next[id] = rows
      return next
    })
  }
  const order = known.map(task => task.id)
  rows.sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib)
  })
  return { rows: settle(rows, now), ids: new Set(all.map(agent => agent.id)) }
}

/** Finds each running foreground shell's output file: its stdout, matched by command text. */
async function linkForegroundShells($: EngineInterface, list: Task[]): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  const found = await $.process.run([
    'sh',
    '-c',
    `root=${TASKS_ROOT}; for p in /proc/[0-9]*; do t=$(readlink "$p/fd/1" 2>/dev/null) || continue; ` +
      'case "$t" in "$root"/*/*/tasks/*.output) printf "%s\\0" "$t"; tr "\\0\\n" "  " <"$p/cmdline"; printf "\\0";; esac; done',
  ])
  const fields = found.stdout.split('\0')
  const flat = (text: string) => text.replace(/[\0\n]/g, ' ')
  for (const shell of list) {
    if (!shell.command) continue
    // A PreToolUse hook may prefix the command (rtk), so the exact eval form is tried first, then the body alone.
    const body = flat(shell.command.replaceAll("'", "'\\''"))
    for (const wanted of [`eval '${body}'`, body]) {
      for (let i = 0; i + 1 < fields.length && !links.has(shell.id); i += 2) {
        const path = fields[i]
        const cmdline = fields[i + 1]
        const isTaken = [...links.values()].includes(path ?? '')
        if (path && cmdline?.includes(wanted) && !isTaken) links.set(shell.id, path)
      }
    }
  }
  return links
}

/** Keeps only the entries of agents the engine still lists. */
const pruned = <T,>(byId: Record<string, T>, ids: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(byId).filter(([id]) => ids.has(id)))

async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    // A failed agent read skips the agents this tick, never the shells' cleanup below.
    const got = await readAgents($, now).catch(() => undefined)
    const nextAgents = got?.rows ?? (await read($, agents))
    const ids = got?.ids ?? new Set(nextAgents.map(agent => agent.id))
    if (got) await update($, agents, () => nextAgents)
    await update($, agentMeta, meta => {
      const next = pruned(meta, ids)
      for (const agent of nextAgents) {
        const one = next[agent.id] ?? { startedAt: agent.startedAt ?? now, contextTokens: 0, outputTokens: 0 }
        next[agent.id] = !agent.isLive && one.endedAt === undefined ? { ...one, endedAt: now } : one
      }
      return next
    })
    await update($, consoles, byId => (Object.keys(byId).every(id => ids.has(id)) ? byId : pruned(byId, ids)))
    // A foreground call outlives no Bash timeout; one older, or from before a reload, has lost its hook.
    await update($, shells, list =>
      list.map(s =>
        s.isLive && s.id.startsWith('fg:') && now - (s.startedAt ?? 0) > FOREGROUND_MAX_MS
          ? { ...s, isLive: false, status: 'lost' }
          : s,
      ),
    )
    let current = await read($, shells)
    const unlinked = current.filter(s => s.isLive && s.id.startsWith('fg:') && !s.outputPath)
    if (unlinked.length > 0) {
      const links = await linkForegroundShells($, unlinked).catch(() => new Map<string, string>())
      current = current.map(s => (links.has(s.id) ? { ...s, outputPath: links.get(s.id) } : s))
    }
    const refreshed = await Promise.all(
      current.map(shell =>
        shell.isLive && (shell.outputPath || shell.id.startsWith('bg:')) ? readShell($, shell).catch(() => shell) : shell,
      ),
    )
    // A shell that ended while this tick read it keeps its final state.
    await update($, shells, list =>
      settle(list.map(shell => (shell.isLive ? (refreshed.find(r => r.id === shell.id) ?? shell) : shell)), now),
    )
    // Polling continues until every ended entry has lingered out of the panel.
    if (nextAgents.length === 0 && (await read($, shells)).length === 0) {
      poll?.cancel()
      poll = undefined
    }
  } finally {
    isTicking = false
  }
}

/** Ends every background shell the engine no longer counts as in flight; at the main loop's stop, every foreground one too. */
async function reconcile(
  $: EngineInterface,
  inFlight: readonly { id: string; type: string; command?: string; description?: string }[],
  isMainStop: boolean,
  fgStatus = 'ended',
  touchBackground = true,
) {
  const now = await $.clock.now()
  // By id first; by command or description too, should the engine's task id differ from the Bash result's.
  const running = (shell: Task) =>
    inFlight.some(
      task =>
        `bg:${task.id}` === shell.id ||
        (task.type === 'shell' &&
          ((task.command !== undefined && task.command === shell.command) ||
            (task.description !== undefined && task.description === shell.title))),
    )
  const list = await read($, shells)
  const gone = list.filter(s => s.isLive && (s.id.startsWith('bg:') ? touchBackground && !running(s) : isMainStop))
  if (gone.length === 0) return
  // A last read picks up an exit trailer written since the previous poll.
  const final = await Promise.all(gone.map(s => (s.id.startsWith('bg:') ? readShell($, s).catch(() => s) : Promise.resolve(s))))
  await update($, shells, current =>
    settle(
      current.map(s => {
        const end = final.find(f => f.id === s.id)
        if (!end || !s.isLive) return s
        return end.isLive ? { ...end, isLive: false, status: end.id.startsWith('fg:') ? fgStatus : 'ended' } : end
      }),
      now,
    ),
  )
}

let isCompacting = false
let autoTimer: { cancel: () => void } | undefined

/** Returns false when the engine rejects the call, as it does while a turn runs. */
async function compactNow($: EngineInterface): Promise<boolean> {
  if (isCompacting) return true
  isCompacting = true
  try {
    const result = await $.session.compact()
    if (result.skip) await $.ui.toast(`Compaction skipped: ${result.skip}`)
    const usage = await $.session.usage()
    await update($, context, () => contextOf(usage.context))
    return true
  } catch {
    return false
  } finally {
    isCompacting = false
  }
}

/** Compacts when queued or once the context reaches 85%, retrying while the turn has not yet let go. */
async function autoCompact($: EngineInterface, triesLeft: number) {
  autoTimer = undefined
  const isQueued = await read($, compactQueued)
  const percent = contextOf((await $.session.usage()).context).percent ?? 0
  if (!isQueued && percent < COMPACT_AT_PERCENT) return
  if (await compactNow($)) {
    await update($, compactQueued, () => false)
    return
  }
  if (triesLeft > 1) autoTimer = $.clock.after(COMPACT_RETRY_MS, () => void autoCompact($, triesLeft - 1))
  else if (isQueued) {
    await update($, compactQueued, () => false)
    await $.ui.toast('Queued compaction failed: press Cmpct now again')
  }
}

/** The person's reset: drops every shell row and every agent row the engine no longer runs. */
async function clearRows($: EngineInterface) {
  await update($, shells, () => [])
  await update($, agents, list => list.filter(agent => agent.isLive))
  await update($, expanded, () => null)
}

function startPolling($: EngineInterface) {
  poll ??= $.clock.every(POLL_MS, () => void tick($))
}

async function appendRow($: EngineInterface, agentId: string, row: ConsoleRow) {
  const kept: ConsoleRow = row.kind === 'text' ? { kind: 'text', text: tailOf(row.text, TEXT_LINES) } : row
  await update($, consoles, byId => {
    const rows = byId[agentId] ?? []
    // A call a transcript backfill already brought in is not logged twice.
    if (kept.kind === 'call' && rows.some(r => r.kind === 'call' && r.id === kept.id)) return byId
    return { ...byId, [agentId]: [...rows, kept].slice(-CONSOLE_ROWS) }
  })
}

/** Logs a subagent's tool call in its console as it starts, and its result as it returns. */
async function agentCall<R extends { deny?: string; text?: string; result?: unknown; isError?: true }>(
  $: EngineInterface,
  agentId: string,
  e: { tool: string; tool_use_id: string },
  next: (e: never) => Promise<R>,
): Promise<R> {
  await appendRow($, agentId, { kind: 'call', id: e.tool_use_id, tool: e.tool, label: callLabel(e as Record<string, unknown>) })
  startPolling($)
  let ran: R | undefined
  try {
    ran = await next(e as never)
    return ran
  } finally {
    const head = resultHead(resultText(ran))
    const isError = !ran || ran.deny !== undefined || ran.isError === true
    await update($, consoles, byId => ({
      ...byId,
      [agentId]: (byId[agentId] ?? []).map(row =>
        row.kind === 'call' && row.id === e.tool_use_id ? { ...row, ...head, isError } : row,
      ),
    }))
  }
}

/** A main-loop Bash call as a Shell row: live while it runs, then its result, or a background task's id. */
async function mainShell<R extends { deny?: string; text?: string; result?: unknown; isError?: true }>(
  $: EngineInterface,
  toolUseId: string,
  command: string,
  description: string | undefined,
  run: () => Promise<R>,
): Promise<R> {
  const shell: Task = {
    id: `fg:${toolUseId}`,
    title: description || (command.split('\n')[0] ?? '').slice(0, 60),
    status: 'running',
    tail: '',
    isLive: true,
    command,
    startedAt: await $.clock.now(),
  }
  await update($, shells, list => [...list, shell])
  startPolling($)
  const finish = async (status: string, text: string) => {
    const now = await $.clock.now()
    await update($, shells, list =>
      settle(
        list.map(s =>
          s.id === shell.id
            ? { ...s, status, isLive: false, tail: tailOf(text), lines: tailOf(text, EXPANDED_LINES) }
            : s,
        ),
        now,
      ),
    )
  }
  let ran: R
  try {
    ran = await run()
  } catch (error) {
    await finish('interrupted', '')
    throw error
  }

  const result = ran.result as { backgroundTaskId?: string; backgroundOutputPath?: string } | undefined
  const taskId = result?.backgroundTaskId
  if (taskId) {
    await update($, shells, list =>
      list.map(s => (s.id === shell.id ? { ...s, id: `bg:${taskId}`, outputPath: undefined } : s)),
    )
    const path = result.backgroundOutputPath ?? (await findOutput($, taskId))
    await update($, shells, list => list.map(s => (s.id === `bg:${taskId}` ? { ...s, outputPath: path } : s)))
  } else {
    const failed = ran.deny !== undefined || ran.isError === true
    await finish(failed ? 'failed' : 'done', resultText(ran))
  }
  startPolling($)
  return ran
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Earlier versions pinned the mode here; a pinned status outlives a reload until cleared.
    await $.ui.status(undefined)
    await $.command.register({
      name: 'monitor',
      description: 'Open the session-cost, agents and shells panel',
    })
    void $.ui.open({ id: PANE, title: 'Monitor', columns: 46 })
    const usage = await $.session.usage()
    const week = weeklyOf(usage.rateLimits)
    if (week) await onWeekly($, week)
    await update($, context, () => contextOf(usage.context))
    startPolling($)
    void tick($)

    return started
  })

  on('command.run', { command: 'monitor' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Monitor', columns: 46 })

    return { text: 'Monitor panel opened.' }
  })

  on('session.measure', async ($, e, next) => {
    const week = weeklyOf(e.rateLimits)
    if (week) await onWeekly($, week)
    await update($, context, () => contextOf(e.context))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId) {
      // No foreground Bash outlives its main turn, an interrupted one included.
      await reconcile($, [], true, e.isAborted ? 'interrupted' : 'ended', false)
      autoTimer?.cancel()
      autoTimer = $.clock.after(250, () => void autoCompact($, COMPACT_TRIES))
    }
    return done
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const agentId = e.agentId
    const usage = step.usage
    if (agentId && step.answer.trim()) await appendRow($, agentId, { kind: 'text', text: step.answer })
    if (agentId && usage) {
      const now = await $.clock.now()
      await update($, agentMeta, meta => {
        const one: AgentMeta = meta[agentId] ?? { startedAt: now, contextTokens: 0, outputTokens: 0 }
        const context = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
        return {
          ...meta,
          [agentId]: { ...one, contextTokens: context, outputTokens: one.outputTokens + usage.output_tokens },
        }
      })
    }
    return step
  })

  // Agents live in the panel, so the footer drops their count; the mode stays, without its cycle hint.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    // State is written outside the draw.
    const named = modeOf(e.props.hint)
    if (named) $.clock.after(0, () => void setMode($, named))
    const hint = footerHint(e.props.hint)
    return hint === e.props.hint ? next(e) : next({ ...e, props: { ...e.props, hint } })
  })

  // Classic hook events name the mode too, which covers a session the footer has not yet named it in.
  on('classic.*', async ($, e, next) => {
    if ('permission_mode' in e && typeof e.permission_mode === 'string') await setMode($, e.permission_mode)
    return next(e)
  })

  // Stop and SubagentStop list the session's in-flight background work: a shell missing from it has ended.
  on('classic.Stop', async ($, e, next) => {
    if (Array.isArray(e.background_tasks)) await reconcile($, e.background_tasks, true)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    if (Array.isArray(e.background_tasks)) await reconcile($, e.background_tasks, false)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') {
      startPolling($)
      void tick($)
    }
    // A subagent's calls, its shells included, live in its console.
    if (e.agentId) return agentCall($, e.agentId, e, next)
    if (e.tool === 'Bash') return mainShell($, e.tool_use_id, e.command, e.description, () => next(e))
    return next(e)
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const shown = await read($, bar)
    const agentList = await read($, agents)
    const shellList = await read($, shells)
    const metaById = await read($, agentMeta)
    const fill = await read($, context)
    const openId = await read($, expanded)
    const activeMode = await read($, mode)
    const isQueued = await read($, compactQueued)
    const now = await $.clock.now()

    const cells = (percent: number, of = width) => Math.round((Math.min(100, Math.max(0, percent)) / 100) * of)

    // While a turn runs, a press queues compaction for its end; a second press cancels the queue.
    const onCompact = async () => {
      if (await read($, compactQueued)) {
        await update($, compactQueued, () => false)
        await $.ui.toast('Queued compaction cancelled')
      } else if (!(await compactNow($))) {
        await update($, compactQueued, () => true)
        await $.ui.toast('A turn is running: compaction runs when it ends')
      }
    }
    const compactLabel = isQueued ? QUEUED_LABEL : COMPACT_LABEL
    const tokens = fill?.tokens !== undefined ? ` ${shortTokens(fill.tokens)}/${shortTokens(fill.window)}` : ''

    const week = shown && (() => {
      const spent = Math.max(0, shown.current - shown.baseline)
      const resets = shown.resetsAt
        ? new Date(shown.resetsAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
        : undefined
      const label = `This: ${shortPercent(spent)}, Week: ${shortPercent(shown.current)}${resets ? `, Rst: ${resets}` : ''}`
      return { spent, label }
    })()

    const agentLine = (meta: AgentMeta) => {
      const seconds = Math.max(0, Math.round(((meta.endedAt ?? now) - meta.startedAt) / 1000))
      const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
      return `${time} · context ${compact(meta.contextTokens)} · out ${compact(meta.outputTokens)} tokens`
    }

    const tasks = [
      ...agentList.map(task => ({ kind: 'Agent', task })),
      ...shellList.map(task => ({ kind: 'Shell', task })),
    ].sort((a, b) => Number(b.task.isLive) - Number(a.task.isLive))
    // An expanded section that has lingered out of the panel falls back to the full list.
    const open = tasks.find(({ task }) => task.id === openId)
    // A tick right after the press fills the expanded view without waiting for the next poll.
    const toggleOf = (task: Task, isOpen: boolean) => async () => {
      await update($, expanded, () => (isOpen ? null : task.id))
      void tick($)
    }

    // Powerline segments: each arrow takes the left segment's shade over the right one's.
    const segments = MODES.filter(([m]) => CYCLE.has(m) || m === activeMode).map(([m, word], i) => ({
      m,
      word,
      isOn: m === activeMode,
      shade: m === activeMode ? ACTIVE : (GREYS[i] ?? GREYS.at(-1)!),
    }))

    if (e.surface !== 'terminal') {
      // A graphical surface draws its own controls: no Nerd Font glyphs, no bars of colored cells.
      const { Box, Button, Code, Progress, Svg, Text } = $.ui.resolve(e)
      const tone = (task: Task) =>
        task.isLive ? 'suggestion' : GOOD_END.has(task.status) ? 'success' : QUIET_END.has(task.status) ? 'inactive' : 'error'
      const contextBlock =
        !fill || fill.percent === undefined ? (
          <Text dimColor>No context reading yet.</Text>
        ) : (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box flexGrow={1}>
              <Progress
                label="Context"
                value={fill.percent}
                max={100}
                valueText={`${Math.round(fill.percent)}%${tokens ? ` ·${tokens}` : ''}`}
                color={heatColors(cells(fill.percent, 100), 100, fill.window).at(-1)}
              />
            </Box>
            <Button key="compact" label={compactLabel} variant={isQueued ? 'primary' : 'secondary'} onPress={onCompact} />
          </Box>
        )
      if (e.props.placement === 'widget') {
        const live = tasks.filter(({ task }) => task.isLive).length
        return (
          <Box flexDirection="column">
            {contextBlock}
            <Text dimColor>{live === 0 ? 'Nothing running' : `${live} running`}</Text>
          </Box>
        )
      }
      const weekBlock = !shown || !week ? (
        <Text dimColor>No weekly-limit reading yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text>{week.label}</Text>
          <Svg source={weekSvg(shown.current, week.spent)} alt={week.label} height={8} />
        </Box>
      )
      const modes = (
        <Text>
          {segments.map((seg, i) => (
            <Text key={seg.m} bold={seg.isOn} color={seg.isOn ? 'success' : 'inactive'}>
              {`${i > 0 ? '  ' : ''}${seg.word}`}
            </Text>
          ))}
        </Text>
      )
      const section = (kind: string, task: Task, isOpen: boolean) => {
        const meta = kind === 'Agent' ? metaById[task.id] : undefined
        return (
          <Box flexDirection="column" key={`${kind}:${task.id}`} marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Text bold>{task.type ? `${kind} · ${task.type}` : kind}</Text>
              <Button
                key={`expand:${task.id}`}
                label={isOpen ? 'Collapse' : 'Expand'}
                variant="secondary"
                onPress={toggleOf(task, isOpen)}
              />
            </Box>
            <Text wrap="truncate-end">
              <Text color={tone(task)}>{task.status}</Text> {task.title}
            </Text>
            {meta && <Text dimColor>{agentLine(meta)}</Text>}
            {isOpen ? (
              <Code source={task.lines || task.tail || 'No output yet.'} wrap="wrap" />
            ) : (
              (task.tail || 'No output yet.').split('\n').map((line, i) => (
                <Text key={String(i)} dimColor wrap="truncate-end">
                  {line}
                </Text>
              ))
            )}
          </Box>
        )
      }
      if (open) return <Box flexDirection="column">{section(open.kind, open.task, true)}</Box>
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            {modes}
            {tasks.length > 0 && <Button key="clear" label="Clear" variant="secondary" onPress={() => clearRows($)} />}
          </Box>
          {weekBlock}
          {contextBlock}
          {tasks.map(({ kind, task }) => section(kind, task, false))}
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    const barRuns = (text: string, fills: { cells: number; color: string }[], of: number, bold?: boolean) =>
      overlay(text, of, fills).map((run, i) =>
        run.background ? (
          <Text key={String(i)} bold={bold} color={inkOn(run.background)} backgroundColor={run.background}>
            {run.text}
          </Text>
        ) : (
          <Text key={String(i)} bold={bold} backgroundColor={TRACK}>
            {run.text}
          </Text>
        ),
      )

    const barLine = (label: string, fills: { cells: number; color: string }[], of = width) => (
      <Text wrap="truncate-end">{barRuns(` ${label}`, fills, of)}</Text>
    )

    const contextSection = () => {
      if (!fill || fill.percent === undefined) {
        return <Text dimColor>No context reading yet.</Text>
      }
      // The bar runs under the Button too: each of its cells is the bar's color there, lifted.
      const label = ` ${compactLabel} `
      const buttonWidth = label.length + 2
      const barWidth = Math.max(4, width - buttonWidth)
      const fills = heatColors(cells(fill.percent), width, fill.window).map(color => ({ cells: 1, color }))
      const under = (i: number) => fills[barWidth + i]?.color ?? TRACK
      const ink = (i: number) => (under(i) === TRACK ? LIGHT_INK : 'black')
      // The caps sit outside the Button, which the pointer inverts: on hover they take the ink the body turns.
      const cap = (i: number, glyph: string, hoverInk: string) => (
        <Text key={`cap:${i}`} color={lift(under(i))} backgroundColor={under(i)} hover={{ color: hoverInk }}>
          {glyph}
        </Text>
      )
      return (
        <Box flexDirection="row">
          {barLine(`Context: ${Math.round(fill.percent)}%${tokens}`, fills.slice(0, barWidth), barWidth)}
          <Box key="compact-pill" flexDirection="row">
            {cap(0, '', ink(1))}
            <Button key="compact" label={compactLabel} plain onPress={onCompact}>
              {[...label].map((char, i) => (
                <Text key={String(i)} bold color={ink(i + 1)} backgroundColor={lift(under(i + 1))}>
                  {char}
                </Text>
              ))}
            </Button>
            {cap(buttonWidth - 1, '', ink(label.length))}
          </Box>
        </Box>
      )
    }

    const weekSection = () => {
      if (!shown || !week) {
        return <Text dimColor>No weekly-limit reading yet.</Text>
      }
      const used = cells(shown.current)
      const mine = Math.min(used, week.spent > 0 ? Math.max(1, cells(week.spent)) : 0)
      return barLine(
        week.label,
        weekColors(used, mine, width).map(color => ({ cells: 1, color })),
      )
    }

    const statusColor = (task: Task) =>
      task.isLive ? 'cyan' : GOOD_END.has(task.status) ? 'green' : QUIET_END.has(task.status) ? GREYS[4] : 'red'

    const taskSection = (kind: string, task: Task, isOpen: boolean) => {
      const meta = kind === 'Agent' ? metaById[task.id] : undefined
      const room = Math.max(1, e.props.scroll.bodyRows - 2 - (meta ? 1 : 0))
      const output = (isOpen ? task.lines || task.tail || ' ' : task.tail || ' ').split('\n').slice(-room)
      const label = ` ${isOpen ? COLLAPSE_GLYPH : EXPAND_GLYPH} `
      const across = width - label.length - 2
      const name = (task.type ? `${kind}:${task.type}` : kind).slice(0, Math.max(0, across - 5))
      return (
        <Box flexDirection="column" key={`${kind}:${task.id}`}>
          <Box flexDirection="row">
            <Text>
              <Text dimColor>─</Text>
              <Text color={TITLE_SHADE}>{ARROW_TAIL}</Text>
              <Text bold color="#d0d0d0" backgroundColor={TITLE_SHADE}>{` ${name} `}</Text>
              <Text color={TITLE_SHADE}>{ARROW}</Text>
              <Text dimColor>{'─'.repeat(Math.max(0, across - 5 - name.length))}</Text>
            </Text>
            <Box key={`pill:${task.id}`} flexDirection="row">
              <Text color={lift(TRACK)} hover={{ color: LIGHT_INK }}>{''}</Text>
              <Button key={`expand:${task.id}`} label={isOpen ? 'Collapse' : 'Expand'} plain onPress={toggleOf(task, isOpen)}>
                <Text bold color={LIGHT_INK} backgroundColor={lift(TRACK)}>
                  {label}
                </Text>
              </Button>
              <Text color={lift(TRACK)} hover={{ color: LIGHT_INK }}>{''}</Text>
            </Box>
          </Box>
          <Text wrap="truncate-end">
            <Text color={statusColor(task)}>[{task.status}]</Text> <Text bold>{task.title}</Text>
          </Text>
          {meta && <Text wrap="truncate-end">{agentLine(meta)}</Text>}
          {output.map((line, i) => (
            <Text key={String(i)} dimColor wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      )
    }

    const modeRow = (
      <Text wrap="truncate-end">
        {segments.flatMap((seg, i) => [
          <Text key={seg.m} bold={seg.isOn} color={seg.isOn ? 'black' : '#d0d0d0'} backgroundColor={seg.shade}>
            {` ${seg.word} `}
          </Text>,
          <Text key={`arrow:${seg.m}`} color={seg.shade} backgroundColor={segments[i + 1]?.shade}>
            {ARROW}
          </Text>,
        ])}
      </Text>
    )

    if (open) return <Box flexDirection="column">{taskSection(open.kind, open.task, true)}</Box>

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          {modeRow}
          {tasks.length > 0 && (
            <Button key="clear" label="Clear" plain dimColor onPress={() => clearRows($)}>
              Clear
            </Button>
          )}
        </Box>
        <Text bold>Session cost</Text>
        {weekSection()}
        {contextSection()}
        {tasks.map(({ kind, task }) => taskSection(kind, task, false))}
      </Box>
    )
  })
}
