import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { footerHint, heatColors, modeOf, overlay, shellStatus, shortPercent, shortTokens, tailOf } from './register'

const measure = (percentUsed: number) => ({
  context: { window: 200_000 },
  rateLimits: [{ kind: 'seven_day', percentUsed, resetsAt: '2026-10-20T10:00:00Z' }],
  changed: ['rateLimits' as const],
})

const PANE = {
  plugin: 'side-monitor',
  component: 'Pane',
  requestId: 'side-monitor',
  props: {
    title: 'Monitor',
    isFocused: false,
    bodyColumns: 42,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const drawn = async ($: Engine, text: RegExp) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found
}

test('the bar shows a new weekly reading at most once per 180 s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))

  expect(await drawn($, /No weekly-limit reading/)).toBeDefined()

  await $.session.measure(measure(40))
  expect(await drawn($, /Week: 40%/)).toBeDefined()
  expect(await drawn($, /This: 0%,/)).toBeDefined()

  await clock.advance(60_000)
  await $.session.measure(measure(42))
  expect(await drawn($, /Week: 40%/)).toBeDefined()

  await clock.advance(119_000)
  expect(await drawn($, /Week: 40%/)).toBeDefined()

  await clock.advance(1_000)
  expect(await drawn($, /Week: 42%/)).toBeDefined()
  expect(await drawn($, /This: 2%,/)).toBeDefined()
})

test('a stored reading from the same window is the baseline', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on, { lastWeekly: { percentUsed: 38, resetsAt: '2026-10-20T10:00:00Z' } })
  on('session.measure', ($, e) => ({ changed: e.changed }))

  await $.session.measure(measure(41))
  expect(await drawn($, /This: 3%,/)).toBeDefined()
})

test('shell trailers and tails', async () => {
  expect(shellStatus('a\n[exited with code 0]')).toBe('done')
  expect(shellStatus('a\n[exited with code 2]')).toBe('exit 2')
  expect(shellStatus('a\n[killed]')).toBe('killed')
  expect(shellStatus('still going')).toBeUndefined()
  expect(tailOf('1\n\n2\n3\n4\n', 3)).toBe('2\n3\n4')
  expect(tailOf('counter: 7\ncounter: 8\n')).toBe('counter: 8')
})

test('the footer drops the agent count and the mode hint, and keeps the rest', async () => {
  expect(footerHint('(shift+tab to cycle) · esc to interrupt · ← 1 agent · ↓ to manage')).toBe('esc to interrupt')
  expect(footerHint('1 shell · ← 5 agents · ↓ to manage')).toBe('1 shell · ↓ to manage')
  expect(footerHint('? for shortcuts')).toBe('? for shortcuts')
  expect(footerHint('2 shells · ↓ to manage')).toBe('2 shells · ↓ to manage')
  expect(footerHint('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')).toBe('⏵⏵ auto mode on · esc to interrupt')
  expect(footerHint('⏵⏵ auto mode on · (shift+tab to cycle)')).toBe('⏵⏵ auto mode on')
})

test('the context bar follows each measure', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))

  expect(await drawn($, /No context reading yet/)).toBeDefined()

  await $.session.measure({ context: { tokens: 84_000, window: 200_000, percent: 42 }, rateLimits: [], changed: ['context'] })
  expect(await drawn($, /^ Context: 42% 84k\/200k/)).toBeDefined()

  await $.session.measure({ context: { tokens: 170_000, window: 200_000 }, rateLimits: [], changed: ['context'] })
  expect(await drawn($, /^ Context: 85% 170k\/200k/)).toBeDefined()
})

test('labels shorten and lie over the bar cells', async () => {
  expect(shortTokens(82_800)).toBe('82.8k')
  expect(shortTokens(1_000_000)).toBe('1m')
  expect(shortPercent(2)).toBe('2%')
  expect(shortPercent(0.34)).toBe('0.3%')
  expect(overlay('abcdef', 8, [{ cells: 3, color: 'white' }, { cells: 2, color: 'yellow' }])).toEqual([
    { text: 'abc', background: 'white' },
    { text: 'de', background: 'yellow' },
    { text: 'f  ', background: undefined },
  ])
})

test('context cells turn redder past 400k and pure red from 75%', async () => {
  const colors = heatColors(18, 20, 1_000_000)
  expect(colors.slice(0, 8).every(c => c === 'cyan')).toBe(true)
  const reds = colors.slice(8, 14)
  const green = (c: string) => parseInt(c.slice(3, 5), 16)
  for (let i = 1; i < reds.length; i++) expect(green(reds[i]!)).toBeLessThan(green(reds[i - 1]!))
  expect(colors.slice(14)).toEqual(['#ff0000', '#ff0000', '#ff0000', '#ff0000'])
  expect(heatColors(20, 20, 200_000).slice(13, 16)).toEqual(['cyan', '#ff0000', '#ff0000'])
})

const usageAt = (percent: number) => ({
  startedAt: 0,
  context: { tokens: percent * 10_000, window: 1_000_000, percent },
  rateLimits: [],
})

const summary = { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }

const turnEnd = (agentId?: string) => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  turnId: 't',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

test('a main turn ending at 85% compacts once; 84% and agent turns do not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let percent = 84
  let compacted = 0
  on('session.usage', () => ({ value: usageAt(percent) }))
  on('session.compact', () => {
    compacted += 1
    percent = 20
    return summary
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd())
  await clock.advance(1_000)
  expect(compacted).toBe(0)

  percent = 90
  await $.turn.complete(turnEnd('agent-1'))
  await clock.advance(1_000)
  expect(compacted).toBe(0)

  await $.turn.complete(turnEnd())
  await clock.advance(1_000)
  expect(compacted).toBe(1)
})

test('a rejected auto-compaction retries until the turn lets go', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let calls = 0
  on('session.usage', () => ({ value: usageAt(calls > 1 ? 10 : 88) }))
  on('session.compact', () => {
    calls += 1
    if (calls === 1) throw new Error('a turn is running')
    return summary
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete(turnEnd())
  await clock.advance(250)
  expect(calls).toBe(1)
  await clock.advance(2_000)
  expect(calls).toBe(2)
  await clock.advance(10_000)
  expect(calls).toBe(2)
})

test('Cmpct now sits on the context row and compacts when pressed', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  let compacted = 0
  on('session.usage', () => ({ value: usageAt(50) }))
  on('session.compact', () => {
    compacted += 1
    return summary
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.measure({ ...usageAt(50), changed: ['context'] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await ui.unmount()
  expect(compacted).toBe(1)
})

test('the bar fills under Cmpct now: a red shade at 90%, track at 50%', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const buttonBackground = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const button = await ui.find({ key: 'compact' })
    await ui.unmount()
    const first = button?.children[0] as { props?: { backgroundColor?: string } } | undefined
    return first?.props?.backgroundColor
  }

  await $.session.measure({ ...usageAt(90), changed: ['context'] })
  expect(/^#ff([0-9a-f]{2})\1$/.test((await buttonBackground()) ?? '')).toBe(true)

  await $.session.measure({ ...usageAt(50), changed: ['context'] })
  expect(await buttonBackground()).toBe('#303030')
})

test('[v] expands a shell section to the pane height and [^] collapses it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
  on('tool.call', () => ({ result: { stdout: lines, stderr: '' } }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'make', description: 'build' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^line 59$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Session cost/ })).toBeDefined()
  const divider = await ui.find({ type: 'Text', text: /^──Shell─+$/ })
  expect(divider?.text).toHaveLength(37)
  const title = divider?.children[1] as { props?: { bold?: boolean } } | undefined
  expect(title?.props?.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Shell · build/ })).toBeUndefined()

  await ui.press({ key: 'expand:fg:a' })
  const shown = await ui.findAll({ type: 'Text', text: /^line \d+$/ })
  expect(shown).toHaveLength(28)
  expect(shown.at(-1)?.text).toBe('line 60')
  expect(shown[0]?.text).toBe('line 33')
  expect(await ui.find({ type: 'Text', text: /Session cost/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: '[^]' })).toBeDefined()

  await ui.press({ key: 'expand:fg:a' })
  expect(await ui.find({ type: 'Text', text: /^line 59$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Session cost/ })).toBeDefined()
  await ui.unmount()
})

test('an agent section names its type once, in the divider', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('agent.list', () => ({
    value: [
      { id: 'a1', type: 'system-architect', name: 'system-architect', description: 'Design invitations', status: 'running' },
    ],
  }))
  on('session.messages', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Agent', tool_use_id: 'x', prompt: 'p', description: 'd' } as never)
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^──Agent:system-architect─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\[running\] Design invitations$/ })).toBeDefined()
  const mentions = (await ui.findAll({ type: 'Text', text: /system-architect/ })).map(found => found.text)
  expect(mentions.sort()).toEqual(['Agent:system-architect', `──Agent:system-architect${'─'.repeat(13)}`])
  await ui.unmount()
})

test('a load clears the status line earlier versions pinned', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { registered: true } }) as never)
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('agent.list', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(3_000)
  expect(statuses).toEqual([undefined])
})

test('the footer names the mode, and default when it names none', async () => {
  expect(modeOf('⏵⏵ auto mode on · esc to interrupt')).toBe('auto')
  expect(modeOf('⏸ plan mode on (shift+tab to cycle)')).toBe('plan')
  expect(modeOf('⏵⏵ accept edits on · ? for shortcuts')).toBe('acceptEdits')
  expect(modeOf('? for shortcuts')).toBe('default')
})

test('the mode row highlights the mode the footer names', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const highlighted = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const words = await ui.findAll({ type: 'Text', text: /^ (default|edits|plan|auto|bypass|dontask) $/ })
    await ui.unmount()
    const on = words.filter(word => (word.props as { backgroundColor?: string }).backgroundColor === 'cyan')
    return { all: words.map(word => word.text.trim()), on: on.map(word => word.text.trim()) }
  }
  on('ui.render', { component: 'PromptHint' }, ($, e) => ({ type: 'Text', props: {}, children: [e.props.hint] }) as never)
  const footer = async (hint: string) => {
    const ui = await $.ui.mount({
      plugin: 'side-monitor',
      component: 'PromptHint',
      surface: 'terminal',
      props: { hint, isDraft: false, isWorking: false },
    } as never)
    await ui.unmount()
    await clock.advance(1)
  }

  expect(await highlighted()).toEqual({ all: ['default', 'edits', 'plan', 'auto'], on: ['default'] })
  await footer('⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt')
  expect((await highlighted()).on).toEqual(['auto'])
  await footer('? for shortcuts')
  expect((await highlighted()).on).toEqual(['default'])
  await footer('⏵⏵ bypass permissions on (shift+tab to cycle)')
  expect(await highlighted()).toEqual({ all: ['default', 'edits', 'plan', 'auto', 'bypass'], on: ['bypass'] })
})
