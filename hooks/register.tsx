import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { AgentSeen, BtwEntry, ContextInfo, McpLoadedTool, PetMood, PetState, RecentCall, ToolStat } from '../types'

type GridCell = { label: string; value: string }

type DisplayMood = PetMood | 'sleeping'

const PANE = 'hud'
const SLEEP_AFTER_MS = 90000
const WRITING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const pet = atom({ plugin: 'klaudy-hud', key: 'pet' } as const, {
  mood: 'idle',
  moodUntil: 0,
  lastActivityAt: Date.now(),
})
const entries = atom({ plugin: 'klaudy-hud', key: 'entries' } as const, [], { shape: 'entries-1' })
const stats = atom({ plugin: 'klaudy-hud', key: 'stats' } as const, {}, { shape: 'stats-1' })
const recent = atom({ plugin: 'klaudy-hud', key: 'recent' } as const, [], { shape: 'recent-2' })
const files = atom({ plugin: 'klaudy-hud', key: 'files' } as const, {}, { shape: 'files-1' })
const agents = atom({ plugin: 'klaudy-hud', key: 'agents' } as const, {}, { shape: 'agents-1' })
const tick = atom({ plugin: 'klaudy-hud', key: 'tick' } as const, 0, { shape: 'tick-1' })
const context = atom({ plugin: 'klaudy-hud', key: 'context' } as const, null, { shape: 'context-5' })
const usedSkills = atom({ plugin: 'klaudy-hud', key: 'usedSkills' } as const, [], { shape: 'used-skills-1' })
const agentModels = atom({ plugin: 'klaudy-hud', key: 'agentModels' } as const, {}, { shape: 'agent-models-1' })
const agentUsage = atom({ plugin: 'klaudy-hud', key: 'agentUsage' } as const, {}, { shape: 'agent-usage-1' })
const collapsed = atom({ plugin: 'klaudy-hud', key: 'collapsed' } as const, {}, { shape: 'collapsed-1' })
const btwRows = atom({ plugin: 'klaudy-hud', key: 'btwRows' } as const, 1, { shape: 'btw-rows-1' })
const btwOffset = atom({ plugin: 'klaudy-hud', key: 'btwOffset' } as const, 0, { shape: 'btw-offset-1' })
// The field keeps the person's typing unless the hook draws a new `value`, so the hard-wrapped
// draft has to be drawn back: a focused field shows each line on one row, cut with "…".
const btwDraft = atom({ plugin: 'klaudy-hud', key: 'btwDraft' } as const, '', { shape: 'btw-draft-1' })

// Ticks run every 250ms; moods that need a calmer beat divide them down.
const TICK_MS = 250
const BLINK_TICKS = 4

// The status bot is 7×3 beside the context meter: antenna, eyes, chin. Only the antenna tip and
// the five cells between the cheeks change, so every mood is a colour plus an eye frame.
const BOT_WIDTH = 7
const WORKING_EYES = [' o o ', 'o o  ', ' o o ', '  o o']

type BotLook = { frame: Color; antenna: Color; eyes: string; isDim?: true }

const getBotLook = (mood: DisplayMood, tickCount: number): BotLook => {
  const blinkOn = Math.floor(tickCount / BLINK_TICKS) % 2 === 1
  if (mood === 'working') {
    return { frame: 'claude', antenna: tickCount % 2 === 0 ? 'warning' : 'claude', eyes: WORKING_EYES[tickCount % WORKING_EYES.length] ?? ' o o ' }
  }
  if (mood === 'happy') return { frame: 'success', antenna: tickCount % 2 === 0 ? 'success' : 'warning', eyes: ' ^ ^ ' }
  if (mood === 'upset') return { frame: blinkOn ? 'error' : 'claude', antenna: 'error', eyes: ' x x ' }
  if (mood === 'sleeping') return { frame: 'inactive', antenna: 'inactive', eyes: ' - - ', isDim: true }

  return { frame: 'claude', antenna: 'claude', eyes: ' o o ' }
}

const SPINNER = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇']

const GUIDANCE =
  'This is a quick side question from the user, asked in a "BTW" side panel while the main work continues. ' +
  'You have no tools here. Answer straight away without thinking it over, directly and briefly, ' +
  'in plain text that fits a narrow terminal pane. No markdown headings. Question: '

const formatMs = (ms: number) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

const formatTokens = (tokens: number) => (tokens >= 1000000 ? `${(tokens / 1000000).toFixed(1).replace('.0', '')}m` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens))

const SHORT_CATEGORY_NAMES: Record<string, string> = {
  'MCP server instructions': 'MCP Instr',
  'MCP tools': 'MCP Tools',
  'Custom agents': 'Agents',
  'Memory files': 'Memory',
  Skills: 'Skills',
  Messages: 'Messages',
}

const getShortCategoryName = (name: string) => SHORT_CATEGORY_NAMES[name] ?? name

const getShortModelName = (model: string) => model.replace(/^claude-/, '').replace(/^claude_/, '')

const getShortToolName = (tool: string) => {
  const matched = tool.match(/^mcp__(.+?)__(.+)$/)
  if (matched === null) return tool

  return `${matched[2]} (${(matched[1] ?? '').replace(/^claude_ai_/, '')})`
}

const makeGridPairs = (cells: GridCell[]): Array<[GridCell, GridCell | undefined]> => {
  const half = Math.ceil(cells.length / 2)
  const pairs: Array<[GridCell, GridCell | undefined]> = []
  for (let index = 0; index < half; index += 1) {
    const left = cells[index]
    if (left !== undefined) pairs.push([left, cells[index + half]])
  }

  return pairs
}

const makeLeaderCell = (cell: GridCell | undefined, width: number) => {
  if (cell === undefined) return { label: ''.padEnd(width), dots: '', value: '' }
  const value = cell.value
  const label = cell.label.slice(0, Math.max(1, width - value.length - 3))
  const dots = '·'.repeat(Math.max(1, width - label.length - value.length - 2))

  return { label, dots, value }
}

const QUOTA_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

const formatResetIn = (resetsAt: string | undefined, now: number) => {
  if (resetsAt === undefined) return ''
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  if (Number.isNaN(minutes)) return ''
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d${hours}h`
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

const refreshContext = async (engine: EngineInterface) => {
  const usage = await engine.session.usage({ breakdown: 'summary' })
  const breakdown = usage.context.breakdown
  const categories = (breakdown?.categories ?? [])
    .filter(category => !category.isDeferred && category.tokens > 0)
    .filter(category => !['Free space', 'Autocompact buffer', 'System prompt', 'System tools'].includes(category.name))
    .slice(0, 10)
    .map(category => ({ name: category.name, tokens: category.tokens }))
  let loadedTools = 0
  const loaded: McpLoadedTool[] = []
  for (const tool of breakdown?.mcpTools ?? []) {
    if (tool.isLoaded) {
      loadedTools += 1
      loaded.push({ label: getShortToolName(tool.name), wire: tool.name })
    }
  }
  const info: ContextInfo = {
    tokens: usage.context.tokens,
    window: usage.context.window,
    percent: usage.context.percent,
    costUsd: usage.cost?.usd ?? 0,
    categories,
    skillsTotal: breakdown?.skills?.totalSkills ?? 0,
    skillsIncluded: breakdown?.skills?.includedSkills ?? 0,
    skillsTokens: breakdown?.skills?.tokens ?? 0,
    autoCompactThreshold: breakdown?.autoCompactThreshold,
    model: breakdown?.model ?? '',
    mcpLoadedTools: loadedTools,
    mcpLoaded: loaded.slice(0, 10),
    rateLimits: (usage.rateLimits ?? []).map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt })),
    updatedAt: Date.now(),
  }
  const before = await read(engine, context)
  const hasChanged = before === null || JSON.stringify({ ...before, updatedAt: 0 }) !== JSON.stringify({ ...info, updatedAt: 0 })
  if (hasChanged) await update(engine, context, () => info)
}

const getShortPath = (path: string) => path.split('/').slice(-2).join('/')

// A row is one line: Text truncation cuts at the width, not at a newline, so a multi-line
// command (heredoc, commit message) would otherwise spill its whole body into the list.
const toOneLine = (text: string) => {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) return ''
  const first = lines[0] ?? ''

  return lines.length > 1 ? `${first} …` : first
}

const getCallDetail = (call: { tool: string; [argument: string]: unknown }): string => {
  const readArgument = (name: string) => (typeof call[name] === 'string' ? (call[name] as string) : '')
  if (call.tool === 'Bash') return readArgument('description') || readArgument('command')
  if (call.tool === 'Agent') return readArgument('description')
  if (call.tool === 'Grep' || call.tool === 'Glob') return readArgument('pattern')
  if (call.tool === 'WebSearch') return readArgument('query')
  const filePath = readArgument('file_path')
  if (filePath !== '') return getShortPath(filePath)

  return ''
}

const getDisplayMood = (state: PetState, now: number): DisplayMood =>
  state.moodUntil > now
    ? state.mood
    : now - state.lastActivityAt > SLEEP_AFTER_MS
      ? 'sleeping'
      : 'idle'

const setMood = async (engine: EngineInterface, mood: PetMood, holdMs: number) => {
  const now = Date.now()
  const next: PetState = { mood, moodUntil: now + holdMs, lastActivityAt: now }
  await update(engine, pet, () => next)
}

const BORDER_LINE_PATTERN = /^[\s─━═╌╍┄┅┈┉╭╮╰╯┌┐└┘├┤┬┴┼│┃▔▁▰▱█▄▀╔╗╚╝║]+$/
const PASTE_ARTIFACT_PATTERN = /[\r\n│┃⏺⎿▰▱█⏎↵⮐]| {3,}\S/

const stripLineArtifacts = (line: string) =>
  line
    .replace(/^\s*(?:[│┃]\s?)+/, '')
    .replace(/(?:\s?[│┃])+\s*$/, '')
    .replace(/^\s*[⏺⎿✻✽✶✳✢●◉○·]\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/[▰▱]+\s*\d*%?/g, '')
    .replace(/[█▄▀╔╗╚╝║⠋⠙⠸⠴⠦⠇♥]+/g, '')
    .replace(/\\?[⏎↵⮐]+\s*(?:ask|new line|new|line)?/g, ' ')
    .replace(/\s+·\s+/g, ' ')
    .replace(/\s*[│┃]+\s*/g, ' ')
    .replace(/ {3,}(?=\S)/g, ' ')

const wrapLongLine = (line: string, width: number): string[] => {
  if (line.length <= width) return [line]
  const rows: string[] = []
  let current = ''
  for (const word of line.split(' ')) {
    let piece = word
    while (piece.length > width) {
      if (current !== '') {
        rows.push(current)
        current = ''
      }
      rows.push(piece.slice(0, width))
      piece = piece.slice(width)
    }
    if (current === '') current = piece
    else if (current.length + 1 + piece.length <= width) current = `${current} ${piece}`
    else {
      rows.push(current)
      current = piece
    }
  }
  if (current !== '' || rows.length === 0) rows.push(current)

  return rows
}

const cleanPastedDraft = (text: string, width: number) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    const isLast = index === lines.length - 1
    if (!isLast && line !== '' && BORDER_LINE_PATTERN.test(line)) continue
    const stripped = isLast ? stripLineArtifacts(line) : stripLineArtifacts(line).replace(/\s+$/, '')
    const isBlank = stripped.trim() === ''
    if (!isLast && isBlank && (kept.length === 0 || kept[kept.length - 1] === '')) continue
    if (isBlank) kept.push(isLast ? stripped : '')
    else kept.push(...wrapLongLine(stripped, width))
  }

  return kept.join('\n')
}

const cleanQuestionText = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter(line => line === '' || !BORDER_LINE_PATTERN.test(line))
    .map(line => stripLineArtifacts(line).replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const askSideQuestion = async (engine: EngineInterface, rawQuestion: string) => {
  const question = cleanQuestionText(rawQuestion)
  if (question === '') return
  const entryId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`
  const entry: BtwEntry = { id: entryId, question, isPending: true, askedAt: Date.now() }
  await update(engine, entries, list => [...list, entry].slice(-40))
  await update(engine, btwOffset, () => 0)
  const reply = await engine.model.fork({ prompt: GUIDANCE + question })
  const answer = reply.isAnswered ? reply.text : `No answer (${reply.reason}).`
  await update(engine, entries, list =>
    list.map(one => (one.id === entryId ? { ...one, isPending: false, answer } : one)),
  )
}

const ACTIVE_AGENT_STATUSES = ['pending', 'running', 'waiting']

const refreshAgents = async (engine: EngineInterface) => {
  const now = Date.now()
  const live = await engine.agent.list()
  const seen = await read(engine, agents)
  const merged: Record<string, AgentSeen> = { ...seen }
  for (const one of live) {
    const before = merged[one.id]
    merged[one.id] = {
      id: one.id,
      type: one.type,
      description: one.description,
      status: one.status,
      firstSeenAt: before?.firstSeenAt ?? now,
    }
  }
  // A finished subagent drops out of the live list instead of reporting `completed`, so anything
  // we last saw active that the list no longer has has ended; left alone it read "running" forever.
  const liveIds = new Set(live.map(one => one.id))
  for (const [id, one] of Object.entries(merged)) {
    if (!liveIds.has(id) && ACTIVE_AGENT_STATUSES.includes(one.status)) merged[id] = { ...one, status: 'completed' }
  }
  if (JSON.stringify(merged) !== JSON.stringify(seen)) await update(engine, agents, () => merged)
}

let clockFrame = 0
let wasAnimating = false
let lastBodyColumns = 48

// The field is as wide as its text (or placeholder) and the engine's focus hint follows it, inside
// two bordered, padded boxes (4 cells each). The hint is "⏎ ask" on a one-row field but grows to
// "⏎ ask · \⏎ new line" once `rows` is 2+, so a one-line question may run 15 cells further
// before it has to wrap. Past either width the hint wraps and the field cuts its text with "…".
const BTW_CHROME_COLUMNS = 8
const BTW_SINGLE_HINT_COLUMNS = 7
const BTW_MULTI_HINT_COLUMNS = 22
const btwSingleColumns = () => Math.max(12, lastBodyColumns - BTW_CHROME_COLUMNS - BTW_SINGLE_HINT_COLUMNS)
const btwTextColumns = () => Math.max(12, lastBodyColumns - BTW_CHROME_COLUMNS - BTW_MULTI_HINT_COLUMNS)
const fitsOneRow = (text: string) => !text.includes('\n') && text.length <= btwSingleColumns()

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'qq',
      description: 'Ask a quick side question in the BTW section without interrupting the main work',
    })
    await $.command.register({ name: 'hud', description: 'Hide or show the HUD pane' })
    void $.ui.open({ id: PANE, title: 'HUD' })
    void refreshContext($)
    $.clock.every(TICK_MS, async () => {
      clockFrame += 1
      const petState = await read($, pet)
      const feed = await read($, recent)
      const seen = await read($, agents)
      const hasRunningCalls = feed.some(one => !one.isDone)
      const hasRunningAgents = Object.values(seen).some(one => one.status === 'running')
      const mood = getDisplayMood(petState, Date.now())
      const isAnimating = hasRunningCalls || hasRunningAgents || mood === 'working' || mood === 'happy' || mood === 'upset'
      // Polling keeps its old 2s / 15s pace; only the drawing got faster.
      if (clockFrame % 8 === 0 && (hasRunningCalls || hasRunningAgents)) await refreshAgents($)
      if (clockFrame % 60 === 0) await refreshContext($)
      if (isAnimating || wasAnimating) await update($, tick, count => count + 1)
      wasAnimating = isAnimating
    })

    return next(e)
  })

  on('command.run', { command: 'qq' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'HUD', focus: true })
    const question = e.args.trim()
    if (question === '') return { text: 'HUD pane opened. Type a question in its BTW box.' }
    void askSideQuestion($, question)

    return { text: 'Asked in the BTW section. The answer lands there.' }
  })

  on('command.run', { command: 'hud' }, async ($) => {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })

      return { text: 'HUD hidden. /hud brings it back.' }
    }
    await $.ui.open({ id: PANE, title: 'HUD' })

    return { text: 'HUD is back.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await setMood($, 'working', 600000)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await setMood($, 'working', 600000)
    const startedAt = Date.now()
    const call: RecentCall = {
      id: e.tool_use_id,
      tool: e.tool,
      detail: toOneLine(getCallDetail(e)),
      startedAt,
      isDone: false,
    }
    await update($, recent, list => [...list, call].slice(-30))
    const ran = await next(e)
    const ms = Date.now() - startedAt
    const isError = ran.deny !== undefined || ran.isError === true
    await update($, recent, list =>
      list.map(one => (one.id === call.id ? { ...one, isDone: true, ms, isError } : one)),
    )
    await update($, stats, byTool => {
      const before: ToolStat = byTool[e.tool] ?? { count: 0, errors: 0, totalMs: 0 }
      return {
        ...byTool,
        [e.tool]: {
          count: before.count + 1,
          errors: before.errors + (isError ? 1 : 0),
          totalMs: before.totalMs + ms,
        },
      }
    })
    if (!isError && WRITING_TOOLS.includes(e.tool) && call.detail !== '') {
      await update($, files, touched => {
        const before = touched[call.detail]
        return {
          ...touched,
          [call.detail]: {
            path: call.detail,
            count: (before?.count ?? 0) + 1,
            lastAt: Date.now(),
          },
        }
      })
    }
    if (e.tool === 'Skill') {
      const skillName = typeof e.skill === 'string' ? e.skill : ''
      if (skillName !== '') {
        await update($, usedSkills, list => (list.includes(skillName) ? list : [...list, skillName]))
      }
    }
    if (isError) await setMood($, 'upset', 8000)

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const loopId = e.agentId
    if (loopId !== undefined && e.usage !== undefined) {
      const contextTokens = e.usage.input_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens
      await update($, agentUsage, known => ({ ...known, [loopId]: contextTokens }))
    }
    if (loopId === undefined) await setMood($, 'happy', 10000)
    else void refreshAgents($)

    return next(e)
  })

  on('ui.input', { element: 'btw-question' }, async ($, e, next) => {
    if (e.kind !== 'change') return next(e)
    if (fitsOneRow(e.value)) return next(e)
    const width = btwTextColumns()
    const cleaned = PASTE_ARTIFACT_PATTERN.test(e.value) ? cleanPastedDraft(e.value, width) : e.value
    const wrapped = cleaned
      .split('\n')
      .flatMap(line => wrapLongLine(line, width))
      .join('\n')

    return wrapped === e.value ? next(e) : next({ ...e, value: wrapped })
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    const spawnedId = ran.agentId
    if (ran.deny === undefined && spawnedId !== undefined && ran.model !== undefined) {
      await update($, agentModels, known => ({ ...known, [spawnedId]: ran.model }))
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Input } = $.ui.resolve(e)
    const petState = await read($, pet)
    const tickCount = await read($, tick)
    const byTool = await read($, stats)
    const feed = await read($, recent)
    const touched = await read($, files)
    const seen = await read($, agents)
    const chat = await read($, entries)
    const contextInfo = await read($, context)
    const invokedSkills = await read($, usedSkills)
    const modelByAgent = await read($, agentModels)
    const usageByAgent = await read($, agentUsage)
    const foldedMap = await read($, collapsed)
    const inputRows = await read($, btwRows)
    const storedOffset = await read($, btwOffset)
    const draft = await read($, btwDraft)
    const isFolded = (key: string) => foldedMap[key] === true
    const toggleFold = (key: string) => {
      void update($, collapsed, folded => ({ ...folded, [key]: folded[key] !== true }))
    }
    const now = Date.now()

    const contextPercent = contextInfo?.percent ?? 0
    const contextColor: Color = contextPercent >= 85 ? 'error' : contextPercent >= 60 ? 'warning' : 'success'
    lastBodyColumns = e.props.bodyColumns ?? 48
    const paneColumns = Math.min(lastBodyColumns, 76)
    const gridCellWidth = Math.min(34, Math.max(16, Math.floor((paneColumns - 2 - 3) / 2)))
    const meterWidth = Math.max(14, paneColumns - 2 - 5)
    // The bot sits right of the meters, so they give up its width plus a gap.
    const quotaMeterWidth = Math.max(8, meterWidth - 14 - BOT_WIDTH - 1)
    const contextBarWidth = Math.max(10, meterWidth + 5 - BOT_WIDTH - 1)
    const contextFilled = Math.min(contextBarWidth, Math.round((contextPercent / 100) * contextBarWidth))
    const quotaRows = (contextInfo?.rateLimits ?? []).map(limit => {
      const percent = Math.round(limit.percentUsed)
      const color: Color = percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'
      return {
        kind: limit.kind,
        label: QUOTA_LABELS[limit.kind] ?? limit.kind,
        percent,
        color,
        filled: Math.min(quotaMeterWidth, Math.round((Math.min(100, limit.percentUsed) / 100) * quotaMeterWidth)),
        resetIn: formatResetIn(limit.resetsAt, now),
      }
    })
    // A limit is one line of text until it nears its cap; only then does it earn a bar.
    const QUOTA_BAR_AT = 70
    const calmQuotas = quotaRows.filter(row => row.percent < QUOTA_BAR_AT)
    const hotQuotas = quotaRows.filter(row => row.percent >= QUOTA_BAR_AT)
    const categoryCells = (contextInfo?.categories ?? []).map(category => ({
      label: getShortCategoryName(category.name),
      value: formatTokens(category.tokens),
    }))
    if (contextInfo !== null) {
      categoryCells.push({ label: 'Cost', value: `$${contextInfo.costUsd.toFixed(2)}` })
    }
    const categoryPairs = makeGridPairs(categoryCells)
    const loadedMcp = contextInfo?.mcpLoaded ?? []
    const loadedMcpCount = contextInfo?.mcpLoadedTools ?? 0
    const runningMcpWires = new Set(feed.filter(one => !one.isDone).map(one => one.tool))
    const mcpRows = [...loadedMcp].sort((left, right) => {
      const leftRunning = runningMcpWires.has(left.wire) ? 1 : 0
      const rightRunning = runningMcpWires.has(right.wire) ? 1 : 0
      if (leftRunning !== rightRunning) return rightRunning - leftRunning

      return (byTool[right.wire]?.count ?? 0) - (byTool[left.wire]?.count ?? 0)
    })
    const activeMcpCount = loadedMcp.filter(tool => runningMcpWires.has(tool.wire)).length

    const mood = getDisplayMood(petState, now)
    const bot = getBotLook(mood, tickCount)

    const agentRows = Object.values(seen)
      .sort((left, right) => right.firstSeenAt - left.firstSeenAt)
      .slice(0, 5)
    const running = feed.filter(one => !one.isDone)
    const finished = feed.filter(one => one.isDone).slice(-6).reverse()
    const fileRows = Object.values(touched)
      .sort((left, right) => right.lastAt - left.lastAt)
      .slice(0, 8)
    const allStats = Object.values(byTool)
    const totalCalls = allStats.reduce((sum, stat) => sum + stat.count, 0)
    const totalErrors = allStats.reduce((sum, stat) => sum + stat.errors, 0)
    const chatTotal = chat.length
    const maxBtwOffset = Math.max(0, chatTotal - 4)
    const btwPage = Math.min(storedOffset, maxBtwOffset)
    const btwStart = Math.max(0, chatTotal - 4 - btwPage)
    const btwEnd = chatTotal - btwPage
    const btwEntries = chat.slice(btwStart, btwEnd)
    const hasBtwPaging = !isFolded('btw') && chatTotal > 4
    const runningAgentCount = Object.values(seen).filter(one => one.status === 'running').length
    const totalAgentCount = Object.values(seen).length
    const touchedFileCount = Object.values(touched).length
    const pendingBtwCount = chat.filter(one => one.isPending).length

    return (
      <Box flexDirection="column" paddingX={1}>
        {contextInfo !== null && (
          <Box flexDirection="column">
            <Box marginBottom={0}>
              <Text backgroundColor="permission" color="inverseText" weight="bold">
                {' CONTEXT '}
              </Text>
            </Box>
            <Box flexDirection="row" marginBottom={1}>
            <Box flexDirection="column" flexGrow={1}>
            <Box justifyContent="space-between" gap={1}>
              <Text weight="bold" wrap="truncate-end">
                {getShortModelName(contextInfo.model)}
              </Text>
              <Text tabular>
                <Text dimColor>
                  {formatTokens(contextInfo.tokens ?? 0)}/{formatTokens(contextInfo.window)}
                </Text>
                <Text color={contextColor}> {contextPercent}%</Text>
              </Text>
            </Box>
            <Box>
              <Text>
                <Text color={contextColor}>{'▰'.repeat(contextFilled)}</Text>
                <Text dimColor>{'▱'.repeat(contextBarWidth - contextFilled)}</Text>
              </Text>
            </Box>
            {quotaRows.length > 0 && (
              <Box flexDirection="column">
                {calmQuotas.length > 0 && (
                  <Text tabular wrap="truncate-end">
                    {calmQuotas.map((row, index) => (
                      <Text key={row.kind}>
                        {index > 0 && <Text dimColor> · </Text>}
                        <Text dimColor>{row.label} </Text>
                        <Text color={row.color}>{row.percent}%</Text>
                        {row.resetIn !== '' && <Text dimColor> ↻{row.resetIn}</Text>}
                      </Text>
                    ))}
                  </Text>
                )}
                {hotQuotas.map(row => (
                  <Text key={row.kind} tabular wrap="truncate-end">
                    <Text dimColor>{row.label.padEnd(5)}</Text>
                    <Text color={row.color}>{'▰'.repeat(row.filled)}</Text>
                    <Text dimColor>{'▱'.repeat(quotaMeterWidth - row.filled)}</Text>
                    <Text color={row.color}> {String(row.percent).padStart(3)}%</Text>
                    {row.resetIn !== '' && <Text dimColor> ↻{row.resetIn}</Text>}
                  </Text>
                ))}
              </Box>
            )}
            </Box>
            <Box flexDirection="column" width={BOT_WIDTH} marginLeft={1}>
              <Text color={bot.frame} dimColor={bot.isDim}>
                {' ▄▄'}
                <Text color={bot.antenna} dimColor={bot.isDim}>█</Text>
                {'▄▄ '}
              </Text>
              <Text color={bot.frame} dimColor={bot.isDim}>
                █<Text color="text" dimColor={bot.isDim}>{bot.eyes}</Text>█
              </Text>
              <Text color={bot.frame} dimColor={bot.isDim}>{' ▀▀▀▀▀ '}</Text>
            </Box>
            </Box>
            {categoryPairs.map(pair => {
              const left = makeLeaderCell(pair[0], gridCellWidth)
              const right = makeLeaderCell(pair[1], gridCellWidth)
              return (
                <Text key={pair[0].label} tabular>
                  {left.label} <Text dimColor>{left.dots}</Text> {left.value}
                  {'   '}
                  {right.label}
                  {right.dots !== '' && <Text dimColor> {right.dots} </Text>}
                  {right.value}
                </Text>
              )
            })}
            {invokedSkills.length > 0 && (
              <Text dimColor wrap="truncate-end">
                skills used: {invokedSkills.join(', ')}
              </Text>
            )}
          </Box>
        )}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box marginBottom={0} justifyContent="space-between" gap={1}>
            <Button key="fold-subagents" plain onPress={() => toggleFold('subagents')}>
              <Text backgroundColor="claude" color="inverseText" weight="bold">
                {' SUBAGENTS '}
              </Text>
            </Button>
            <Box gap={1}>
              {isFolded('subagents') && totalAgentCount > 0 && (
                <Text tabular>
                  {runningAgentCount > 0 && <Text color="success">{runningAgentCount} active · </Text>}
                  <Text dimColor>{totalAgentCount}</Text>
                </Text>
              )}
              <Button key="fold-subagents-sign" plain label={isFolded('subagents') ? '+' : '−'} onPress={() => toggleFold('subagents')} />
            </Box>
          </Box>
          {!isFolded('subagents') && agentRows.length === 0 && <Text dimColor> none spawned yet</Text>}
          {!isFolded('subagents') && agentRows.map(agent => (
            <Box key={agent.id} justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">
                <Text color={agent.status === 'running' ? 'success' : 'inactive'}>
                  {agent.status === 'running' ? '▶ ' : '✓ '}
                </Text>
                <Text weight="bold">{agent.type}</Text>
                {modelByAgent[agent.id] !== undefined && (
                  <Text color="suggestion"> {getShortModelName(modelByAgent[agent.id] ?? '')}</Text>
                )}
                <Text dimColor> {agent.description}</Text>
              </Text>
              <Text color={agent.status === 'running' ? 'success' : 'inactive'} tabular>
                {agent.status === 'running' ? formatMs(now - agent.firstSeenAt) : agent.status}
                {usageByAgent[agent.id] !== undefined
                  ? ` · ${formatTokens(usageByAgent[agent.id] ?? 0)}`
                  : ''}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box marginBottom={0} justifyContent="space-between" gap={1}>
            <Button key="fold-activity" plain onPress={() => toggleFold('activity')}>
              <Text backgroundColor="warning" color="inverseText" weight="bold">
                {' ACTIVITY '}
              </Text>
            </Button>
            <Box gap={1}>
              {isFolded('activity') && totalCalls > 0 && (
                <Text tabular>
                  {running.length > 0 && <Text color="warning">{running.length} active · </Text>}
                  <Text dimColor>{totalCalls} calls</Text>
                </Text>
              )}
              <Button key="fold-activity-sign" plain label={isFolded('activity') ? '+' : '−'} onPress={() => toggleFold('activity')} />
            </Box>
          </Box>
          {!isFolded('activity') && running.length === 0 && finished.length === 0 && <Text dimColor> idle</Text>}
          {!isFolded('activity') && running.map(one => (
            <Box key={one.id} justifyContent="space-between" gap={1}>
              <Text color="warning" wrap="truncate-end">
                ● {getShortToolName(one.tool)}
                <Text dimColor> {toOneLine(one.detail)}</Text>
              </Text>
              <Text color="warning" tabular>
                {formatMs(now - one.startedAt)}
              </Text>
            </Box>
          ))}
          {!isFolded('activity') && finished.map(one => (
            <Box key={one.id} justifyContent="space-between" gap={1}>
              <Text wrap="truncate-end">
                {one.isError ? <Text color="error">✗ </Text> : <Text dimColor>· </Text>}
                <Text dimColor>
                  {getShortToolName(one.tool)} {toOneLine(one.detail)}
                </Text>
              </Text>
              <Text dimColor tabular>
                {formatMs(one.ms ?? 0)}
              </Text>
            </Box>
          ))}
          {!isFolded('activity') && totalCalls > 0 && (
            <Text dimColor>
              {' '}
              {totalCalls} calls this session
              {totalErrors > 0 ? `, ${totalErrors} failed` : ''}
            </Text>
          )}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box marginBottom={0} justifyContent="space-between" gap={1}>
            <Button key="fold-files" plain onPress={() => toggleFold('files')}>
              <Text backgroundColor="suggestion" color="inverseText" weight="bold">
                {' FILES TOUCHED '}
              </Text>
            </Button>
            <Box gap={1}>
              {isFolded('files') && touchedFileCount > 0 && (
                <Text dimColor tabular>
                  {touchedFileCount} files
                </Text>
              )}
              <Button key="fold-files-sign" plain label={isFolded('files') ? '+' : '−'} onPress={() => toggleFold('files')} />
            </Box>
          </Box>
          {!isFolded('files') && fileRows.length === 0 && <Text dimColor> none yet</Text>}
          {!isFolded('files') && fileRows.map(file => (
            <Box key={file.path} justifyContent="space-between" gap={1}>
              <Text wrap="truncate-start">{file.path}</Text>
              <Text dimColor tabular>
                {file.count > 1 ? `×${file.count}` : ''}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box marginBottom={0} justifyContent="space-between" gap={1}>
            <Button key="fold-mcp" plain onPress={() => toggleFold('mcp')}>
              <Text backgroundColor="ide" color="inverseText" weight="bold">
                {' MCP '}
              </Text>
            </Button>
            <Box gap={1}>
              {isFolded('mcp') && activeMcpCount > 0 && (
                <Text color="warning" tabular>
                  {activeMcpCount} active ·
                </Text>
              )}
              {isFolded('mcp') && loadedMcpCount > 0 && (
                <Text dimColor tabular>
                  {loadedMcpCount} loaded
                </Text>
              )}
              <Button key="fold-mcp-sign" plain label={isFolded('mcp') ? '+' : '−'} onPress={() => toggleFold('mcp')} />
            </Box>
          </Box>
          {!isFolded('mcp') && mcpRows.length === 0 && <Text dimColor> none loaded yet</Text>}
          {!isFolded('mcp') && mcpRows.map((tool: McpLoadedTool) => {
            const callCount = byTool[tool.wire]?.count ?? 0
            const isRunning = runningMcpWires.has(tool.wire)
            return (
              <Box key={tool.wire} justifyContent="space-between" gap={1}>
                <Text color={isRunning ? 'warning' : undefined} wrap="truncate-end">
                  {isRunning ? `${SPINNER[tickCount % SPINNER.length]} ` : ''}{tool.label}
                </Text>
                {isRunning ? (
                  <Text color="warning" tabular>running…</Text>
                ) : (
                  <Text dimColor tabular>
                    {callCount > 0 ? `×${callCount}` : 'loaded'}
                  </Text>
                )}
              </Box>
            )
          })}
          {!isFolded('mcp') && loadedMcpCount > loadedMcp.length && (
            <Text dimColor> +{loadedMcpCount - loadedMcp.length} more loaded</Text>
          )}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="success" paddingX={1} paddingBottom={1}>
          <Box marginBottom={isFolded('btw') ? 0 : 1} justifyContent="space-between" gap={1}>
            <Button key="fold-btw" plain onPress={() => toggleFold('btw')}>
              <Text backgroundColor="success" color="inverseText" weight="bold">
                {' BTW '}
              </Text>
              {/* The long subtitle crowds the header's buttons off the row once there are questions. */}
              {chatTotal === 0 && <Text dimColor> side questions, answered without interrupting</Text>}
            </Button>
            <Box gap={1}>
              {isFolded('btw') && chatTotal > 0 && (
                <Text tabular>
                  {pendingBtwCount > 0 && <Text color="warning">{pendingBtwCount} pending · </Text>}
                  <Text dimColor>{chatTotal}</Text>
                </Text>
              )}
              {!isFolded('btw') && chatTotal > 0 && (
                <Button
                  key="btw-clear"
                  plain
                  onPress={() => {
                    void update($, entries, () => [])
                    void update($, btwOffset, () => 0)
                    $.ui.toast(`Cleared ${chatTotal} side question${chatTotal === 1 ? '' : 's'}`)
                  }}
                >
                  <Text color="error">✕ clear all</Text>
                </Button>
              )}
              {hasBtwPaging && (
                <Text dimColor tabular>
                  {btwStart + 1}–{btwEnd}/{chatTotal}
                </Text>
              )}
              {hasBtwPaging && (
                <Button
                  key="btw-older"
                  plain
                  label="▲"
                  onPress={() => void update($, btwOffset, current => Math.min(maxBtwOffset, current + 1))}
                />
              )}
              {hasBtwPaging && (
                <Button
                  key="btw-newer"
                  plain
                  label="▼"
                  onPress={() => void update($, btwOffset, current => Math.max(0, current - 1))}
                />
              )}
              <Button key="fold-btw-sign" plain label={isFolded('btw') ? '+' : '−'} onPress={() => toggleFold('btw')} />
            </Box>
          </Box>
          {!isFolded('btw') && chat.length === 0 && (
            <Box marginBottom={1}>
              <Text dimColor>Ask anything below. The main agent keeps working.</Text>
            </Box>
          )}
          {!isFolded('btw') && btwEntries.map(entry => (
            <Box key={entry.id} flexDirection="column" marginBottom={1}>
              <Text color="claude" weight="bold">
                {'› '}
                {entry.question.replace(/\s*\n+\s*/g, ' ')}
              </Text>
              {entry.isPending ? (
                <Text color="warning">✦ thinking…</Text>
              ) : (
                <Text>{entry.answer}</Text>
              )}
            </Box>
          ))}
          {!isFolded('btw') && (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Input
              key="btw-question"
              placeholder={'Ask anything…'.padEnd(btwSingleColumns())}
              submitLabel="ask"
              rows={inputRows}
              value={draft}
              onInput={value => {
                const textColumns = btwTextColumns()
                const lineCount = value
                  .split('\n')
                  .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / textColumns)), 0)
                const nextRows = fitsOneRow(value) ? 1 : Math.min(10, Math.max(2, lineCount))
                void (async () => {
                  if ((await read($, btwDraft)) !== value) await update($, btwDraft, () => value)
                  const currentRows = await read($, btwRows)
                  if (currentRows !== nextRows) await update($, btwRows, () => nextRows)
                })()
              }}
              onSubmit={value => {
                if (value.trim() !== '') void askSideQuestion($, value)
                void update($, btwDraft, () => '')
                void update($, btwRows, () => 1)
              }}
            />
          </Box>
          )}
        </Box>
      </Box>
    )
  })
}
