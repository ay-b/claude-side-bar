import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { footerHint, heatColors, inkOn, lift, modeOf, overlay, weekColors, shellStatus, shortPercent, shortTokens, tailOf } from './register'

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

test('context cells run light green to orange to red from the first cell, pure red from 75%', async () => {
  const colors = heatColors(20, 20, 1_000_000)
  const rgb = (c: string) => [1, 3, 5].map(n => parseInt(c.slice(n, n + 2), 16))
  // Cell 1 sits 1/15 of the way to red, so it is mostly the light green stop.
  expect(rgb(colors[0]!)).toEqual([159, 216, 125])
  expect(rgb(heatColors(20, 40, 400_000)[14]!)).toEqual([0xff, 0xa5, 0x00])
  for (let i = 1; i < 15; i++) {
    const [r0, g0] = rgb(colors[i - 1]!)
    const [r1, g1] = rgb(colors[i]!)
    expect(r1).toBeGreaterThanOrEqual(r0!)
    if (i > 7) expect(g1).toBeLessThan(g0!)
  }
  expect(colors.slice(14)).toEqual(Array(6).fill('#ff0000'))
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

test('Cmpct now is a rounded button one lift above the bar beneath it, reddish once filled', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  type Cell = { children?: unknown[]; props?: { color?: string; backgroundColor?: string } }
  const button = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ key: 'compact' })
    await ui.unmount()
    const cells = (found?.children ?? []) as Cell[]
    return { left: cells[0], inner: cells.slice(1, -1), right: cells.at(-1) }
  }

  expect(lift('#303030')).toBe('#4a4a4a')
  expect(lift('#ff0000')).toBe('#ff1a1a')

  await $.session.measure({ ...usageAt(50), changed: ['context'] })
  const empty = await button()
  expect(empty.left?.children).toEqual(['\ue0b6'])
  expect(empty.right?.children).toEqual(['\ue0b4'])
  expect(empty.left?.props).toMatchObject({ color: '#4a4a4a', backgroundColor: '#303030' })
  expect(empty.inner.map(c => c.props?.backgroundColor)).toEqual(Array(11).fill('#4a4a4a'))

  await $.session.measure({ ...usageAt(99), changed: ['context'] })
  const full = await button()
  // The pane is 40 cells wide: the button covers cells 27 to 39, all filled at 99%.
  const heat = heatColors(40, 40, 1_000_000)
  expect(full.left?.props).toMatchObject({ color: lift(heat[27]!), backgroundColor: heat[27] })
  expect(full.inner.map(c => c.props?.backgroundColor)).toEqual(heat.slice(28, 39).map(lift))
  expect(full.right?.props).toMatchObject({ color: lift(heat[39]!), backgroundColor: heat[39] })
  expect(heat[39]).toBe('#ff0000')
})

test('the chevron pill expands a shell section to the pane height and collapses it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
  on('tool.call', () => ({ result: { stdout: lines, stderr: '' } }))
  await $.tool.call({ tool: 'Bash', tool_use_id: 'a', command: 'make', description: 'build' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^line 59$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Session cost/ })).toBeDefined()
  const divider = await ui.find({ type: 'Text', text: /^─\ue0d7 Shell \ue0b0─+$/ })
  expect(divider?.text).toHaveLength(35)
  const pill = await ui.find({ type: 'Button', key: 'expand:fg:a' })
  expect(pill?.text).toBe('  ')
  const [, tail, title, arrow] = (divider?.children ?? []) as { props?: Record<string, unknown> }[]
  expect(title?.props).toMatchObject({ bold: true, backgroundColor: '#444444' })
  expect(tail?.props).toMatchObject({ color: '#444444' })
  expect(arrow?.props).toMatchObject({ color: '#444444' })
  expect(arrow?.props?.backgroundColor).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Shell · build/ })).toBeUndefined()

  await ui.press({ key: 'expand:fg:a' })
  const shown = await ui.findAll({ type: 'Text', text: /^line \d+$/ })
  expect(shown).toHaveLength(28)
  expect(shown.at(-1)?.text).toBe('line 60')
  expect(shown[0]?.text).toBe('line 33')
  expect(await ui.find({ type: 'Text', text: /Session cost/ })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'expand:fg:a' }))?.text).toBe('  ')

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
  expect(await ui.find({ type: 'Text', text: /^─\ue0d7 Agent:system-architect \ue0b0─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\[running\] Design invitations$/ })).toBeDefined()
  const mentions = (await ui.findAll({ type: 'Text', text: /system-architect/ })).map(found => found.text)
  expect(mentions.sort()).toEqual([' Agent:system-architect ', `─\ue0d7 Agent:system-architect \ue0b0${'─'.repeat(8)}`])
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

test('the footer names the mode shift+tab left, so the next one is on', async () => {
  expect(modeOf('auto mode on (shift+tab to cycle) · ← 1 agent')).toBe('default')
  expect(modeOf('manual mode on · ? for shortcuts · ← 1 agent')).toBe('acceptEdits')
  expect(modeOf('accept edits on (shift+tab to cycle) · ← 1 agent')).toBe('plan')
  expect(modeOf('plan mode on (shift+tab to cycle) · ← 1 agent')).toBe('auto')
  expect(modeOf('bypass permissions on (shift+tab to cycle)')).toBeUndefined()
  expect(modeOf('(shift+tab to cycle) · ← 1 agent')).toBeUndefined()
  expect(modeOf('? for shortcuts · ← 1 agent')).toBeUndefined()
})

test('the mode row follows shift+tab and hook events', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const highlighted = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const words = await ui.findAll({ type: 'Text', text: /^ (manual|edits|plan|auto|bypass|dontask) $/ })
    await ui.unmount()
    const lit = words.filter(word => (word.props as { bold?: boolean }).bold === true)
    return { all: words.map(word => word.text.trim()), on: lit.map(word => word.text.trim()) }
  }
  on('classic.UserPromptSubmit', () => ({}))
  const prompt = (permission_mode: string) =>
    $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode } as never)
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
  // shift+tab: a render naming the mode left, then an unnamed one a millisecond later, as the engine sends them.
  const shiftTab = async (named: string) => {
    await footer(named)
    await footer('(shift+tab to cycle) · ← 1 agent')
  }

  expect(await highlighted()).toEqual({ all: ['manual', 'edits', 'plan', 'auto'], on: ['manual'] })
  await shiftTab('manual mode on · ? for shortcuts · ← 1 agent')
  expect((await highlighted()).on).toEqual(['edits'])
  await shiftTab('accept edits on (shift+tab to cycle) · ← 1 agent')
  expect((await highlighted()).on).toEqual(['plan'])
  await shiftTab('plan mode on (shift+tab to cycle) · ← 1 agent')
  expect((await highlighted()).on).toEqual(['auto'])
  await shiftTab('auto mode on (shift+tab to cycle) · ← 1 agent')
  expect((await highlighted()).on).toEqual(['manual'])
  await prompt('bypassPermissions')
  expect(await highlighted()).toEqual({ all: ['manual', 'edits', 'plan', 'auto', 'bypass'], on: ['bypass'] })

  // Each arrow joins its segment's shade to the next one's; the active shade differs from its rest shade.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const shade = async (text: RegExp) =>
    ((await ui.find({ type: 'Text', text }))?.props as { backgroundColor?: string } | undefined)?.backgroundColor
  const arrows = (await ui.findAll({ type: 'Text', text: /^\ue0b0$/ })).map(
    found => found.props as { color?: string; backgroundColor?: string },
  )
  const shades = [await shade(/^ manual $/), await shade(/^ edits $/), await shade(/^ plan $/), await shade(/^ auto $/), await shade(/^ bypass $/)]
  expect(arrows.map(a => a.color)).toEqual(shades)
  expect(arrows.map(a => a.backgroundColor)).toEqual([...shades.slice(1), undefined])
  expect(new Set(shades).size).toBe(5)
  await ui.unmount()
  await prompt('auto')
  const ui2 = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const autoOn = ((await ui2.find({ type: 'Text', text: /^ auto $/ }))?.props as { backgroundColor?: string }).backgroundColor
  await ui2.unmount()
  expect(autoOn).not.toBe(shades[3])
  expect(shades.slice(0, 4)).toEqual(['#303030', '#444444', '#585858', '#6c6c6c'])
  expect(shades[4]).toBe(autoOn)
})

test('the weekly bar runs very light to dark blue across the bar; this session stays solid yellow', async () => {
  const cells = weekColors(30, 5, 40)
  const lum = (c: string) => [1, 3, 5].map(n => parseInt(c.slice(n, n + 2), 16)).reduce((a, b) => a + b, 0)
  expect(cells[0]).toBe('#cfe8ff')
  expect(weekColors(40, 0, 40)[39]).toBe('#0a2a6b')
  for (let i = 1; i < 25; i++) expect(lum(cells[i]!)).toBeLessThan(lum(cells[i - 1]!))
  expect(cells.slice(25)).toEqual(Array(5).fill('yellow'))
  expect(inkOn('#cfe8ff')).toBe('black')
  expect(inkOn('#0a2a6b')).toBe('white')
  expect(inkOn('yellow')).toBe('black')
})
