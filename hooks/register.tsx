import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { AgentMeta, Bar, ContextFill, Task, Weekly } from '../types'

const PANE = 'side-monitor'
const BAR_MIN_INTERVAL_MS = 180_000
const POLL_MS = 3_000
const ENDED_LINGER_MS = 10_000
const TAIL_LINES = 1
const EXPANDED_LINES = 300
const TRACK = '#303030'
const COMPACT_AT_PERCENT = 85
const HEAT_FROM_TOKENS = 400_000
const HEAT_FULL_PERCENT = 75
const COOL = 'cyan'
const COMPACT_LABEL = 'Cmpct now'
const COMPACT_RETRY_MS = 2_000
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

/** Colors each filled cell: cool up to 400k tokens, then redder per cell, pure red from 75%. */
export const heatColors = (filled: number, width: number, window: number): string[] => {
  const full = (HEAT_FULL_PERCENT / 100) * window
  return Array.from({ length: filled }, (_, i) => {
    const at = ((i + 1) / width) * window
    if (at >= full) return '#ff0000'
    if (at <= HEAT_FROM_TOKENS) return COOL
    const hex = Math.round(200 * (1 - (at - HEAT_FROM_TOKENS) / (full - HEAT_FROM_TOKENS)))
      .toString(16)
      .padStart(2, '0')
    return `#ff${hex}${hex}`
  })
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
// Each mode's hue: bleached at rest, saturated while active.
const MODES: [mode: string, word: string, label: RegExp, pale: string, vivid: string][] = [
  ['default', 'manual', /\bmanual mode on\b/, '#b58c8c', '#ff2a2a'],
  ['acceptEdits', 'edits', /\baccept edits on\b/, '#b89e85', '#ff8c00'],
  ['plan', 'plan', /\bplan mode on\b/, '#b3ae85', '#ffd700'],
  ['auto', 'auto', /\bauto mode on\b/, '#8cad91', '#00d75f'],
  ['bypassPermissions', 'bypass', /\bbypass permissions on\b/, '#ad8ca8', '#ff00d7'],
  ['dontAsk', 'dontask', /\bdon't ask mode on\b/, '#8c9cb3', '#0087ff'],
]
const ARROW = '\ue0b0'
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
let tasksDir: string | undefined
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

async function findTasksDir($: EngineInterface) {
  if (tasksDir) return tasksDir
  const id = await $.session.id()
  const found = await $.process.run([
    'sh',
    '-c',
    'ls -d "${CLAUDE_CODE_TMPDIR:-${TMPDIR:-/tmp}}"/claude-$(id -u)/*/"$1"/tasks 2>/dev/null | head -n1',
    'sh',
    id,
  ])
  tasksDir = found.stdout.trim() || undefined
  return tasksDir
}

async function readShell($: EngineInterface, shell: Task): Promise<Task> {
  const dir = await findTasksDir($)
  const path = shell.outputPath ?? (dir && `${dir}/${shell.id}.output`)
  if (!path) return { ...shell, tail: 'output file not found' }
  const out = await $.process.run(['tail', '-c', '32000', path])
  if (out.exitCode !== 0) return { ...shell, outputPath: path, tail: 'output file not found' }
  const all = tailOf(out.stdout, EXPANDED_LINES + 1)
  const ended = shellStatus(all)
  const lines = ended ? all.split('\n').slice(0, -1).join('\n') : all
  return {
    ...shell,
    outputPath: path,
    status: ended ?? 'running',
    isLive: !ended,
    tail: tailOf(lines),
    lines,
  }
}

async function readAgents($: EngineInterface, now: number): Promise<Task[]> {
  const known = await read($, agents)
  const all = await $.agent.list()
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
      let tail = before?.tail ?? ''
      let lines = before?.lines
      // Ended agents keep their last tail; read the transcript once more as they end.
      const messages = isLive || !before || before.isLive ? await $.session.messages({ agentId: agent.id }) : undefined
      if (Array.isArray(messages)) {
        const last = [...messages].reverse().find(m => m.role === 'assistant')
        const usedTool = last?.toolUses.at(-1)?.tool
        tail = last?.text ? tailOf(last.text) : usedTool ? `using ${usedTool}` : tail
        lines = last?.text ? tailOf(last.text, EXPANDED_LINES) : tail
      }
      return {
        id: agent.id,
        // The divider shows the type; a name the engine derived from it would repeat it.
        title: agent.description || (agent.name !== agent.type ? agent.name : undefined) || '',
        type: agent.type,
        status: agent.status,
        tail,
        lines,
        isLive,
        endedAt: before?.endedAt,
      }
    }),
  )
  const order = known.map(task => task.id)
  rows.sort((a, b) => {
    const ia = order.indexOf(a.id)
    const ib = order.indexOf(b.id)
    return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib)
  })
  return settle(rows, now)
}

/** Finds each running foreground shell's output file: its stdout, matched by command text. */
async function linkForegroundShells($: EngineInterface, list: Task[]): Promise<Map<string, string>> {
  const links = new Map<string, string>()
  const dir = await findTasksDir($)
  if (!dir) return links
  const found = await $.process.run([
    'sh',
    '-c',
    'for p in /proc/[0-9]*; do t=$(readlink "$p/fd/1" 2>/dev/null) || continue; ' +
      'case "$t" in "$1"/*) printf "%s\\0" "$t"; tr "\\0\\n" "  " <"$p/cmdline"; printf "\\0";; esac; done',
    'sh',
    dir,
  ])
  const fields = found.stdout.split('\0')
  const flat = (text: string) => text.replace(/[\0\n]/g, ' ')
  for (const shell of list) {
    if (!shell.command) continue
    const quoted = flat(`eval '${shell.command.replaceAll("'", "'\\''")}'`)
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const path = fields[i]
      const cmdline = fields[i + 1]
      const isTaken = [...links.values()].includes(path ?? '')
      if (path && cmdline?.includes(quoted) && !isTaken) {
        links.set(shell.id, path)
        break
      }
    }
  }
  return links
}

async function tick($: EngineInterface) {
  if (isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const nextAgents = await readAgents($, now)
    await update($, agents, () => nextAgents)
    await update($, agentMeta, meta => {
      const next = { ...meta }
      for (const agent of nextAgents) {
        const one = next[agent.id] ?? { startedAt: now, contextTokens: 0, outputTokens: 0 }
        next[agent.id] = !agent.isLive && one.endedAt === undefined ? { ...one, endedAt: now } : one
      }
      return next
    })
    let current = await read($, shells)
    const unlinked = current.filter(s => s.isLive && s.id.startsWith('fg:') && !s.outputPath)
    if (unlinked.length > 0) {
      const links = await linkForegroundShells($, unlinked)
      current = current.map(s => (links.has(s.id) ? { ...s, outputPath: links.get(s.id) } : s))
    }
    const refreshed = await Promise.all(
      current.map(shell =>
        shell.isLive && (shell.outputPath || shell.id.startsWith('bg:')) ? readShell($, shell) : shell,
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

/** Compacts once the context reaches 85%, retrying while the turn has not yet let go. */
async function autoCompact($: EngineInterface, triesLeft: number) {
  autoTimer = undefined
  const percent = contextOf((await $.session.usage()).context).percent ?? 0
  if (percent < COMPACT_AT_PERCENT || (await compactNow($))) return
  if (triesLeft > 1) autoTimer = $.clock.after(COMPACT_RETRY_MS, () => void autoCompact($, triesLeft - 1))
}

function startPolling($: EngineInterface) {
  poll ??= $.clock.every(POLL_MS, () => void tick($))
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
      autoTimer?.cancel()
      autoTimer = $.clock.after(250, () => void autoCompact($, COMPACT_TRIES))
    }
    return done
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const agentId = e.agentId
    const usage = step.usage
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

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    startPolling($)
    void tick($)

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const title = e.description || (e.command.split('\n')[0] ?? '').slice(0, 60)
    const shell: Task = {
      id: `fg:${e.tool_use_id}`,
      title,
      status: 'running',
      tail: '',
      isLive: true,
      command: e.command,
    }
    await update($, shells, list => [...list, shell])
    startPolling($)
    const ran = await next(e)

    const result = ran.result as { stdout?: string; stderr?: string; backgroundTaskId?: string } | undefined
    const taskId = result?.backgroundTaskId
    if (taskId) {
      await update($, shells, list =>
        list.map(s => (s.id === shell.id ? { ...s, id: `bg:${taskId}`, outputPath: undefined } : s)),
      )
      const dir = await findTasksDir($)
      await update($, shells, list =>
        list.map(s => (s.id === `bg:${taskId}` ? { ...s, outputPath: dir && `${dir}/${taskId}.output` } : s)),
      )
      startPolling($)
    } else {
      const failed = 'deny' in ran || ran.isError
      const text = result ? `${result.stdout ?? ''}\n${result.stderr ?? ''}` : (ran.text ?? '')
      const now = await $.clock.now()
      await update($, shells, list =>
        settle(
          list.map(s =>
            s.id === shell.id
              ? {
                  ...s,
                  status: failed ? 'failed' : 'done',
                  isLive: false,
                  tail: tailOf(text),
                  lines: tailOf(text, EXPANDED_LINES),
                }
              : s,
          ),
          now,
        ),
      )
      startPolling($)
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = Math.max(10, (e.props.bodyColumns ?? 40) - 2)
    const shown = await read($, bar)
    const agentList = await read($, agents)
    const shellList = await read($, shells)
    const metaById = await read($, agentMeta)
    const fill = await read($, context)
    const openId = await read($, expanded)
    const activeMode = await read($, mode)
    const now = await $.clock.now()

    const cells = (percent: number, of = width) => Math.round((Math.min(100, Math.max(0, percent)) / 100) * of)

    const barRuns = (text: string, fills: { cells: number; color: string }[], of: number, bold?: boolean) =>
      overlay(text, of, fills).map((run, i) =>
        run.background ? (
          <Text key={String(i)} bold={bold} color="black" backgroundColor={run.background}>
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
      // The bar runs under the Button too: its last cells, brackets included, are the Button's own.
      const button = `[ ${COMPACT_LABEL} ]`
      const barWidth = Math.max(4, width - button.length)
      const fills = heatColors(cells(fill.percent), width, fill.window).map(color => ({ cells: 1, color }))
      const tokens = fill.tokens !== undefined ? ` ${shortTokens(fill.tokens)}/${shortTokens(fill.window)}` : ''
      const onCompact = async () => {
        if (!(await compactNow($))) await $.ui.toast('A turn is running: press Cmpct now after it ends')
      }
      return (
        <Box flexDirection="row">
          {barLine(`Context: ${Math.round(fill.percent)}%${tokens}`, fills.slice(0, barWidth), barWidth)}
          <Button key="compact" label={COMPACT_LABEL} plain onPress={onCompact}>
            {barRuns(button, fills.slice(barWidth), button.length, true)}
          </Button>
        </Box>
      )
    }

    const weekSection = () => {
      if (!shown) {
        return <Text dimColor>No weekly-limit reading yet.</Text>
      }
      const spent = Math.max(0, shown.current - shown.baseline)
      const used = cells(shown.current)
      const mine = Math.min(used, spent > 0 ? Math.max(1, cells(spent)) : 0)
      const resets = shown.resetsAt
        ? new Date(shown.resetsAt).toLocaleString('en-GB', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : undefined

      const label = `This: ${shortPercent(spent)}, Week: ${shortPercent(shown.current)}${resets ? `, Rst: ${resets}` : ''}`
      return barLine(label, [
        { cells: used - mine, color: 'white' },
        { cells: mine, color: 'yellow' },
      ])
    }

    const agentLine = (meta: AgentMeta) => {
      const seconds = Math.max(0, Math.round(((meta.endedAt ?? now) - meta.startedAt) / 1000))
      const time = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`
      return `${time} · context ${compact(meta.contextTokens)} · out ${compact(meta.outputTokens)} tokens`
    }

    const statusColor = (task: Task) =>
      task.isLive ? 'cyan' : task.status === 'done' || task.status === 'completed' ? 'green' : 'red'

    const tasks = [
      ...agentList.map(task => ({ kind: 'Agent', task })),
      ...shellList.map(task => ({ kind: 'Shell', task })),
    ].sort((a, b) => Number(b.task.isLive) - Number(a.task.isLive))
    // An expanded section that has lingered out of the panel falls back to the full list.
    const open = tasks.find(({ task }) => task.id === openId)

    const taskSection = (kind: string, task: Task, isOpen: boolean) => {
      const meta = kind === 'Agent' ? metaById[task.id] : undefined
      const room = Math.max(1, e.props.scroll.bodyRows - 2 - (meta ? 1 : 0))
      const output = isOpen ? (task.lines || task.tail || ' ').split('\n').slice(-room) : [task.tail || ' ']
      const toggle = () => update($, expanded, () => (isOpen ? null : task.id))
      const label = isOpen ? '[^]' : '[v]'
      const across = width - label.length
      const name = (task.type ? `${kind}:${task.type}` : kind).slice(0, Math.max(0, across - 2))
      return (
        <Box flexDirection="column" key={`${kind}:${task.id}`}>
          <Box flexDirection="row">
            <Text>
              <Text dimColor>──</Text>
              <Text bold>{name}</Text>
              <Text dimColor>{'─'.repeat(Math.max(0, across - 2 - name.length))}</Text>
            </Text>
            <Button key={`expand:${task.id}`} label={label} plain dimColor onPress={toggle} />
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

    // Powerline segments: each arrow takes the left segment's shade over the right one's.
    const segments = MODES.filter(([m]) => CYCLE.has(m) || m === activeMode).map(([m, word, , pale, vivid]) => ({
      m,
      word,
      isOn: m === activeMode,
      shade: m === activeMode ? vivid : pale,
    }))
    const modeRow = (
      <Text wrap="truncate-end">
        {segments.flatMap((seg, i) => [
          <Text key={seg.m} bold={seg.isOn} color={seg.isOn ? 'black' : '#3a3a3a'} backgroundColor={seg.shade}>
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
        {modeRow}
        <Text bold>Session cost</Text>
        {weekSection()}
        {contextSection()}
        {tasks.map(({ kind, task }) => taskSection(kind, task, false))}
      </Box>
    )
  })
}
