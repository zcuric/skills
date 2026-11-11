import type { Elements, RenderSurface } from 'claude-code'

import type { Risk, StageStatus } from '../types'
import type { Color } from './runs'

type Els = Elements[RenderSurface]

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'merged' | 'muted'

/** Theme keys, so every surface follows the person's theme. */
export const INK: Record<Tone, Color> = {
  good: 'success',
  warn: 'warning',
  bad: 'error',
  info: 'suggestion',
  merged: 'merged',
  muted: 'inactive',
}

/** Fixed hues for SVG markup and translucent fills, readable on light and dark. */
const HUE: Record<Tone, [number, number, number]> = {
  good: [45, 164, 78],
  warn: [212, 167, 44],
  bad: [207, 34, 46],
  info: [9, 105, 218],
  merged: [130, 80, 223],
  muted: [140, 149, 159],
}

export const STATUS_TONE: Record<StageStatus, Tone> = { pending: 'muted', running: 'warn', done: 'good', failed: 'bad', skipped: 'muted' }
export const RISK_TONE: Record<Risk, Tone> = { low: 'good', medium: 'warn', high: 'bad' }

/** Good from 80, warn from 60, bad below; muted when nothing is scored. */
export function confidenceTone(value: number | undefined): Tone {
  if (value === undefined) return 'muted'
  if (value >= 80) return 'good'
  if (value >= 60) return 'warn'
  return 'bad'
}

export const hex = (tone: Tone): string => `#${HUE[tone].map(part => part.toString(16).padStart(2, '0')).join('')}`

/** A Svg-drawing surface (desktop, the editor, phones) takes fills and drawings; the terminal does not. */
export const isGraphic = (els: Els): boolean => 'Svg' in els

/** A translucent fill of the tone on graphical surfaces; nothing on the terminal. */
export const tint = (els: Els, tone: Tone, alpha = 0.12): Color =>
  isGraphic(els) ? `rgba(${HUE[tone].join(', ')}, ${alpha})` : undefined

/** A rounded label: a soft fill on graphical surfaces, inverse text on the terminal. */
export function chip(els: Els, text: string, tone: Tone, options: { key?: string; size?: 'footnote' | 'body' | 'heading' } = {}) {
  const { Box, Text } = els
  if (!isGraphic(els)) {
    if (tone === 'muted') return <Text key={options.key} dimColor tabular>{` ${text} `}</Text>
    return <Text key={options.key} color={INK[tone]} inverse weight="bold" tabular>{` ${text} `}</Text>
  }
  return (
    <Box key={options.key} backgroundColor={tint(els, tone, tone === 'muted' ? 0.16 : 0.14)} paddingX={1} flexShrink={0}>
      <Text color={tone === 'muted' ? undefined : INK[tone]} dimColor={tone === 'muted'} weight="semibold" tabular size={options.size ?? 'footnote'}>
        {text}
      </Text>
    </Box>
  )
}

/** A thin stacked bar, e.g. passed / failed / pending checks. Graphical surfaces only. */
export function bar(els: Els, key: string, parts: Array<{ value: number; tone: Tone }>, alt: string) {
  if (!('Svg' in els)) return null
  const { Svg } = els
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  const width = 240
  let at = 0
  const rects = total === 0
    ? [`<rect x="0" y="0" width="${width}" height="6" rx="3" fill="${hex('muted')}" fill-opacity="0.3"/>`]
    : parts.filter(part => part.value > 0).map(part => {
      const w = (part.value / total) * width
      const rect = `<rect x="${at.toFixed(1)}" y="0" width="${Math.max(0, w - 1).toFixed(1)}" height="6" fill="${hex(part.tone)}"/>`
      at += w
      return rect
    })
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 6" width="${width}" height="6" preserveAspectRatio="none">` +
    `<clipPath id="r"><rect width="${width}" height="6" rx="3"/></clipPath><g clip-path="url(#r)">${rects.join('')}</g></svg>`
  return <Svg key={key} source={source} alt={alt} height={6} />
}

/** GitHub's five-square diff stat: `+12 −3 ■■■■□`. */
export function diffBlocks(els: Els, additions: number, deletions: number) {
  const { Text } = els
  const total = additions + deletions
  const green = total === 0 ? 0 : Math.round((additions / total) * 5)
  const red = total === 0 ? 0 : 5 - green
  return (
    <Text tabular>
      <Text color={INK.good} weight="semibold">{`+${additions}`}</Text>
      <Text color={INK.bad} weight="semibold">{` −${deletions} `}</Text>
      <Text color={INK.good}>{'■'.repeat(green)}</Text>
      <Text color={INK.bad}>{'■'.repeat(red)}</Text>
      <Text dimColor>{'■'.repeat(5 - green - red)}</Text>
    </Text>
  )
}

/** A ring filled to `value`%: the confidence gauge beside its label. */
export function gauge(els: Els, key: string, value: number | undefined, size = 22) {
  if (!('Svg' in els)) return null
  const { Svg } = els
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const filled = ((value ?? 0) / 100) * circumference
  const tone = confidenceTone(value)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="${size}" height="${size}">` +
    `<circle cx="11" cy="11" r="${radius}" fill="none" stroke="${hex('muted')}" stroke-opacity="0.3" stroke-width="3.5"/>` +
    `<circle cx="11" cy="11" r="${radius}" fill="none" stroke="${hex(tone)}" stroke-width="3.5" stroke-linecap="round" ` +
    `stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 11 11)"/></svg>`
  return <Svg key={key} source={source} alt={value === undefined ? 'No confidence yet' : `${value}% confidence`} width={size} height={size} />
}

/** A breathing dot for the stage that runs now; the terminal keeps its glyph. */
export function pulse(els: Els, key: string, tone: Tone) {
  if (!('Svg' in els)) return null
  const { Svg } = els
  const color = hex(tone)
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" width="14" height="14">' +
    `<circle cx="7" cy="7" r="3" fill="${color}"><animate attributeName="r" values="5;6.5;5" dur="1.6s" repeatCount="indefinite"/>` +
    `<animate attributeName="fill-opacity" values="0.25;0;0.25" dur="1.6s" repeatCount="indefinite"/></circle>` +
    `<circle cx="7" cy="7" r="3.5" fill="${color}"/></svg>`
  return <Svg key={key} source={source} alt="running" width={14} height={14} isInteractive />
}

/** One segment per stage, coloured by status: the run at a glance. */
export function track(els: Els, key: string, statuses: readonly StageStatus[], alt: string) {
  if (!('Svg' in els)) return null
  const { Svg } = els
  const gap = 3
  const width = 270
  const segment = (width - gap * (statuses.length - 1)) / statuses.length
  const rects = statuses.map((status, at) => {
    const x = (at * (segment + gap)).toFixed(1)
    const opacity = status === 'pending' ? 0.22 : status === 'skipped' ? 0.5 : 1
    return `<rect x="${x}" y="0" width="${segment.toFixed(1)}" height="4" rx="2" fill="${hex(STATUS_TONE[status])}" fill-opacity="${opacity}"/>`
  })
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 4" width="${width}" height="4" preserveAspectRatio="none">${rects.join('')}</svg>`
  return <Svg key={key} source={source} alt={alt} height={4} />
}
