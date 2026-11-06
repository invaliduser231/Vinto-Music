import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';

export interface NowPlayingCardInput {
  title: string;
  artist?: string | null;
  durationSec?: number | null;
  positionSec?: number | null;
  isLive?: boolean;
  sourceLabel?: string | null;
  accentColor?: number | null;
  upNext?: string | null;
  queueLength?: number;
  cover?: Uint8Array | null;
  coverIsLetterboxed?: boolean;
  labels?: Partial<CardLabels>;
}

export interface CardLabels {
  upNext: string;
  live: string;
  moreInQueue: string;
}

const DEFAULT_LABELS: CardLabels = {
  upNext: 'Up next',
  live: 'Live',
  moreInQueue: '+{count} more',
};

const WIDTH = 1200;
const HEIGHT = 400;
const FONT_FAMILY = 'Vinto Inter';
const FONT_FILES: Array<[string, string]> = [
  ['Inter-Regular.ttf', FONT_FAMILY],
  ['Inter-Medium.ttf', FONT_FAMILY],
  ['Inter-SemiBold.ttf', FONT_FAMILY],
  ['Inter-Bold.ttf', FONT_FAMILY],
];

const SUPPORTED_TEXT = /^[ -ɏ̀-ͯͰ-ϿЀ-ӿḀ-ỿ -⁯₠-⃏℀-↏←-⇿∀-⋿]*$/u;

let fontsReady: boolean | null = null;

function findFontDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), 'assets', 'fonts'),
    resolve(here, '..', '..', '..', 'assets', 'fonts'),
    resolve(here, '..', '..', '..', '..', 'assets', 'fonts'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'Inter-Regular.ttf'))) ?? null;
}

export function ensureCardFonts(): boolean {
  if (fontsReady !== null) return fontsReady;
  const directory = findFontDirectory();
  if (!directory) {
    fontsReady = false;
    return false;
  }
  for (const [file, family] of FONT_FILES) {
    GlobalFonts.registerFromPath(join(directory, file), family);
  }
  fontsReady = true;
  return true;
}

export function canRenderCardText(...values: Array<string | null | undefined>): boolean {
  return values.every((value) => SUPPORTED_TEXT.test(String(value ?? '')));
}

function formatClock(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function font(weight: 400 | 500 | 600 | 700, size: number): string {
  return `${weight} ${size}px "${FONT_FAMILY}"`;
}

function rgb(color: number, alpha = 1): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(color: number, target: number, amount: number): number {
  const channel = (shift: number) => {
    const from = (color >> shift) & 0xff;
    const to = (target >> shift) & 0xff;
    return Math.round(from + (to - from) * amount) & 0xff;
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function ellipsize(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${chars.slice(0, mid).join('').trimEnd()}…`;
    if (ctx.measureText(candidate).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${chars.slice(0, low).join('').trimEnd()}…`;
}

function wrapLines(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines - 1) {
      current = [current, ...words.slice(index + 1)].join(' ');
      break;
    }
  }
  if (current) lines.push(current);

  return lines.slice(0, maxLines).map((line, index) => (
    index === maxLines - 1 || ctx.measureText(line).width > maxWidth ? ellipsize(ctx, line, maxWidth) : line
  ));
}

function roundedRect(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.closePath();
}

type CoverCrop = { sx: number; sy: number; size: number };

function squareCrop(image: Image, letterboxed: boolean): CoverCrop {
  let { width, height } = image;
  let offsetY = 0;
  if (letterboxed && width / height < 1.7) {
    const videoHeight = Math.round(width * 9 / 16);
    offsetY = Math.round((height - videoHeight) / 2);
    height = videoHeight;
  }
  const size = Math.min(width, height);
  return {
    sx: Math.round((width - size) / 2),
    sy: offsetY + Math.round((height - size) / 2),
    size,
  };
}

function drawCover(ctx: SKRSContext2D, image: Image | null, crop: CoverCrop | null, x: number, y: number, size: number, accent: number): void {
  if (image && crop) {
    ctx.drawImage(image, crop.sx, crop.sy, crop.size, crop.size, x, y, size, size);
    return;
  }
  const gradient = ctx.createLinearGradient(x, y, x + size, y + size);
  gradient.addColorStop(0, rgb(mix(accent, 0xffffff, 0.15)));
  gradient.addColorStop(1, rgb(mix(accent, 0x000000, 0.45)));
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  const noteX = x + size * 0.42;
  const noteY = y + size * 0.64;
  ctx.beginPath();
  ctx.ellipse(noteX, noteY, size * 0.09, size * 0.07, -0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(noteX + size * 0.07, y + size * 0.28, size * 0.035, size * 0.36);
  ctx.fillRect(noteX + size * 0.07, y + size * 0.28, size * 0.16, size * 0.05);
}

function averageColor(image: Image, crop: CoverCrop): number {
  const sample = createCanvas(8, 8);
  const sctx = sample.getContext('2d');
  sctx.drawImage(image, crop.sx, crop.sy, crop.size, crop.size, 0, 0, 8, 8);
  const data = sctx.getImageData(0, 0, 8, 8).data;
  let best = { score: -1, color: 0xff2d78 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (let index = 0; index < data.length; index += 4) {
    const pr = data[index]!;
    const pg = data[index + 1]!;
    const pb = data[index + 2]!;
    r += pr;
    g += pg;
    b += pb;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const score = saturation * (max / 255);
    if (score > best.score) best = { score, color: (pr << 16) | (pg << 8) | pb };
  }
  if (best.score > 0.25) return best.color;
  const count = data.length / 4;
  return (Math.round(r / count) << 16) | (Math.round(g / count) << 8) | Math.round(b / count);
}

type Layout = {
  ctx: SKRSContext2D;
  input: NowPlayingCardInput;
  labels: CardLabels;
  image: Image | null;
  crop: CoverCrop | null;
  accent: number;
};

function drawTextBlock(layout: Layout, x: number, maxWidth: number, colors: { primary: string; secondary: string; muted: string }): void {
  const { ctx, input, labels } = layout;

  ctx.textBaseline = 'alphabetic';
  ctx.font = font(700, 50);
  const titleLines = wrapLines(ctx, input.title, maxWidth, 2);
  const artist = String(input.artist ?? '').trim();
  const upNext = String(input.upNext ?? '').trim();

  let y = titleLines.length > 1 ? 104 : 128;
  ctx.fillStyle = colors.primary;
  for (const line of titleLines) {
    ctx.fillText(line, x, y);
    y += 60;
  }

  if (artist) {
    ctx.font = font(500, 32);
    ctx.fillStyle = colors.secondary;
    ctx.fillText(ellipsize(ctx, artist, maxWidth), x, y - 6);
    y += 44;
  }

  if (upNext) {
    ctx.font = font(500, 24);
    ctx.fillStyle = colors.muted;
    const extra = Math.max(0, (input.queueLength ?? 1) - 1);
    const suffix = extra > 0 ? `  ${labels.moreInQueue.replace('{count}', String(extra))}` : '';
    ctx.fillText(ellipsize(ctx, `${labels.upNext}: ${upNext}${suffix}`, maxWidth), x, y);
  }
}

function drawProgress(layout: Layout, x: number, y: number, width: number, colors: { track: string; fill: string; text: string; knob: string }): void {
  const { ctx, input, labels } = layout;
  const duration = Math.max(0, Number(input.durationSec ?? 0));
  const position = Math.max(0, Math.min(duration || Infinity, Number(input.positionSec ?? 0)));

  ctx.font = font(600, 22);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = colors.text;

  if (input.isLive || duration <= 0) {
    ctx.fillStyle = colors.fill;
    ctx.beginPath();
    ctx.arc(x + 7, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors.text;
    ctx.fillText(labels.live, x + 24, y + 1);
    return;
  }

  const left = formatClock(position);
  const right = formatClock(duration);
  const leftWidth = ctx.measureText(left).width;
  const rightWidth = ctx.measureText(right).width;
  const barX = x + leftWidth + 20;
  const barWidth = width - leftWidth - rightWidth - 40;
  const ratio = duration > 0 ? position / duration : 0;

  ctx.fillText(left, x, y + 1);
  ctx.fillText(right, x + width - rightWidth, y + 1);

  ctx.fillStyle = colors.track;
  roundedRect(ctx, barX, y - 4, barWidth, 8, 4);
  ctx.fill();

  ctx.fillStyle = colors.fill;
  roundedRect(ctx, barX, y - 4, Math.max(8, barWidth * ratio), 8, 4);
  ctx.fill();

  ctx.fillStyle = colors.knob;
  ctx.beginPath();
  ctx.arc(barX + Math.max(4, barWidth * ratio), y, 10, 0, Math.PI * 2);
  ctx.fill();
}

function drawSource(layout: Layout, rightX: number, y: number, color: string): void {
  const { ctx, input } = layout;
  const label = String(input.sourceLabel ?? '').trim();
  if (!label) return;
  ctx.font = font(500, 22);
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(label).width;
  ctx.fillStyle = color;
  ctx.fillText(label, rightX - width, y);
}

function renderAmbient(layout: Layout): void {
  const { ctx, image, crop, accent } = layout;

  if (image && crop) {
    ctx.save();
    ctx.filter = 'blur(48px) saturate(140%)';
    ctx.drawImage(image, crop.sx, crop.sy, crop.size, crop.size, -120, -520, WIDTH + 240, WIDTH + 240);
    ctx.restore();
  } else {
    ctx.fillStyle = rgb(mix(accent, 0x000000, 0.5));
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  const shade = ctx.createLinearGradient(0, 0, WIDTH, 0);
  shade.addColorStop(0, 'rgba(8, 8, 12, 0.55)');
  shade.addColorStop(1, 'rgba(8, 8, 12, 0.78)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const coverSize = 304;
  const coverX = 48;
  const coverY = 48;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 12;
  roundedRect(ctx, coverX, coverY, coverSize, coverSize, 22);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundedRect(ctx, coverX, coverY, coverSize, coverSize, 22);
  ctx.clip();
  drawCover(ctx, image, crop, coverX, coverY, coverSize, accent);
  ctx.restore();

  const textX = coverX + coverSize + 48;
  const textWidth = WIDTH - textX - 56;
  drawTextBlock(layout, textX, textWidth, {
    primary: '#ffffff',
    secondary: 'rgba(255, 255, 255, 0.78)',
    muted: 'rgba(255, 255, 255, 0.55)',
  });
  drawProgress(layout, textX, 322, textWidth, {
    track: 'rgba(255, 255, 255, 0.22)',
    fill: '#ffffff',
    text: 'rgba(255, 255, 255, 0.75)',
    knob: '#ffffff',
  });
  drawSource(layout, WIDTH - 56, 52, 'rgba(255, 255, 255, 0.6)');
}

export async function renderNowPlayingCard(input: NowPlayingCardInput): Promise<Buffer | null> {
  if (!ensureCardFonts()) return null;
  if (!canRenderCardText(input.title, input.artist, input.upNext)) return null;

  const image = input.cover?.byteLength
    ? await loadImage(Buffer.from(input.cover)).catch(() => null)
    : null;
  const crop = image ? squareCrop(image, input.coverIsLetterboxed === true) : null;
  const accent = image && crop ? averageColor(image, crop) : (input.accentColor ?? 0xff2d78);

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.save();
  roundedRect(ctx, 0, 0, WIDTH, HEIGHT, 28);
  ctx.clip();

  renderAmbient({
    ctx,
    input,
    labels: { ...DEFAULT_LABELS, ...(input.labels ?? {}) },
    image,
    crop,
    accent,
  });
  ctx.restore();

  return canvas.encode('png');
}
