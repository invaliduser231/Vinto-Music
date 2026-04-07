import { spawn } from 'child_process';
import { PassThrough } from 'node:stream';
import playdl from 'play-dl';
import { LiveAudioProcessor, isLiveFilterPresetSupported } from '../LiveAudioProcessor.ts';
import { ValidationError } from '../../core/errors.ts';
import { FILTER_PRESETS } from './constants.ts';
import { isRetryableYtDlpStartupError } from './errorUtils.ts';
import {
  clamp,
  isYouTubeUrl,
  pickThumbnailUrlFromItem,
  pickTrackArtistFromMetadata,
} from './trackUtils.ts';
import type { PipelineProcess } from '../../types/domain.ts';

type LooseMethodMap = Record<string, (this: any, ...args: any[]) => any>;
type YtDlpSearchEntry = Record<string, unknown> & {
  id?: unknown;
  webpage_url?: unknown;
  url?: unknown;
  title?: unknown;
  duration?: unknown;
};
type ProcessOutputProc = PipelineProcess & {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  stdout?: (NonNullable<PipelineProcess['stdout']> & {
    once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  }) | null;
};

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === 'object' && 'code' in err);
}

function isPythonModuleCommand(cmd: string) {
  const normalized = String(cmd ?? '').trim().toLowerCase();
  return normalized === 'py' || normalized === 'python' || normalized === 'python3';
}

export const pipelineMethods: LooseMethodMap = {
  _getYtDlpClientStrategies() {
    const configured = String(this.ytdlpYoutubeClient ?? '').trim();
    if (!configured) return [false];

    const tokens = configured
      .split(',')
      .map((token: string) => token.trim())
      .filter(Boolean);

    const strategies: Array<boolean | string> = [configured];
    for (const token of tokens) {
      if (!strategies.includes(token)) {
        strategies.push(token);
      }
    }
    strategies.push(false);
    return strategies;
  },

  _resolveYtDlpClientArg(includeClientArg: boolean | string | null | undefined) {
    if (typeof includeClientArg === 'string') {
      return includeClientArg.trim() || null;
    }
    if (includeClientArg === true) {
      return String(this.ytdlpYoutubeClient ?? '').trim() || null;
    }
    return null;
  },

  _ffmpegHttpArgs(inputUrl: string, seekSec = 0, options: { isLive?: boolean } = {}) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const isLive = options?.isLive === true;
    const args = [
      ...(isLive ? ['-re'] : []),
      '-nostdin',
      '-user_agent', 'Mozilla/5.0 (compatible; FluxerBot/1.0)',
    ];

    if (isLive) {
      args.push('-headers', 'Icy-MetaData:1\r\n');
    }

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-i', inputUrl,
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  },

  async _startPlayDlPipeline(url: string, seekSec = 0) {
    const options = { quality: 2 };
    if (seekSec > 0 && isYouTubeUrl(url)) {
      Object.assign(options, { seek: seekSec });
    }

    const stream = await playdl.stream(url, options);
    this.sourceStream = stream.stream;

    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegArgs(), {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.sourceStream, 'source.stream');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');

    const onSourceStreamError = () => {
      this.ffmpeg?.kill('SIGKILL');
    };
    this.sourceStream.on('error', onSourceStreamError);
    this.pipelineErrorHandlers.push(() => {
      this.sourceStream?.off?.('error', onSourceStreamError);
    });

    this.sourceStream.pipe(this.ffmpeg.stdin);
  },

  async _startHttpUrlPipeline(url: string, seekSec = 0, options: { isLive?: boolean } = {}) {
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, this._ffmpegHttpArgs(url, seekSec, options), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
    this._bindPipelineErrorHandler(this.ffmpeg.stderr, 'ffmpeg.stderr');
  },

  async _startYouTubePipeline(url: string, seekSec = 0) {
    if (!this.enableYtPlayback) {
      throw new ValidationError('YouTube playback is currently disabled by bot configuration.');
    }

    try {
      await this._startYtDlpPipeline(url, seekSec);
      return;
    } catch (err) {
      this.logger?.warn?.('yt-dlp YouTube startup failed, falling back to play-dl pipeline', {
        url,
        seekSec,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this._startPlayDlPipeline(url, seekSec);
  },

  async _startYtDlpPipeline(url: string, seekSec = 0) {
    const attempts = [];
    const strategies = this._getYtDlpClientStrategies();
    const formats = ['bestaudio/best', null];
    for (const format of formats) {
      for (const includeClientArg of strategies) {
        attempts.push({ format, includeClientArg });
      }
    }

    let lastErr = null;

    for (const attempt of attempts) {
      try {
        await this._startYtDlpPipelineWithFormat(url, seekSec, attempt.format, attempt.includeClientArg);
        return;
      } catch (err: unknown) {
        this._cleanupProcesses();
        lastErr = err;
        if (!isRetryableYtDlpStartupError(err)) {
          throw err;
        }

        this.logger?.warn?.('yt-dlp startup strategy failed, retrying with next strategy', {
          format: attempt.format ?? '(default)',
          includeClientArg: attempt.includeClientArg,
          seekSec,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw lastErr ?? new Error('yt-dlp format selection failed');
  },

  async _startYtDlpSeekPipeline(
    url: string,
    seekSec = 0,
    formatSelector: string | null = 'bestaudio/best',
    includeClientArg: boolean | string | null = true
  ) {
    this._lastYtDlpDiagnostics = {
      formatSelector: formatSelector ?? null,
      includeClientArg: Boolean(includeClientArg),
      selectedFormats: formatSelector ?? null,
      selectedItag: null,
      updatedAt: new Date().toISOString(),
    };

    const streamUrl = await this._resolveYtDlpStreamUrl(url, formatSelector, includeClientArg);
    if (!streamUrl) {
      throw new Error('yt-dlp returned no direct media URL for seek playback.');
    }

    const ffmpegArgs = this._ffmpegHttpArgs(streamUrl, seekSec);
    this._lastFfmpegArgs = [...ffmpegArgs];
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
  },

  async _startYtDlpPipelineWithFormat(
    url: string,
    seekSec = 0,
    formatSelector: string | null = 'bestaudio/best',
    includeClientArg: boolean | string | null = true
  ) {
    this._lastYtDlpDiagnostics = {
      formatSelector: formatSelector ?? null,
      includeClientArg: Boolean(includeClientArg),
      selectedFormats: null,
      selectedItag: null,
      updatedAt: new Date().toISOString(),
    };

    this.sourceProc = await this._spawnYtDlp(url, formatSelector, includeClientArg);
    this.sourceProc.stderr?.setEncoding?.('utf8');

    let stderr = '';
    let stderrBuffer = '';
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const onStderr = (chunk: unknown) => {
      const text = String(chunk ?? '');
      stderr = `${stderr}${text}`.slice(-4096);
      this._trackYtDlpFormatSelection(text);

      if (!ytdlpVerboseEnabled) return;
      stderrBuffer = `${stderrBuffer}${text}`;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          this.logger?.info?.('yt-dlp verbose', { line: trimmed });
        }
      }
    };
    this.sourceProc.stderr?.on?.('data', onStderr);
    this.sourceProc.once?.('close', (code: unknown, signal: unknown) => {
      const normalizedCode = typeof code === 'number' && Number.isFinite(code) ? code : null;
      const normalizedSignal = signal ? String(signal) : null;
      const stderrTail = stderr.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(' | ') || null;
      this.activeSourceProcessCloseInfo = {
        code: normalizedCode,
        signal: normalizedSignal,
        atMs: Date.now(),
        stderrTail,
        url,
      };
      this.sourceProc?.stderr?.off?.('data', onStderr);
    });

    const ffmpegArgs = this._ffmpegArgs(seekSec);
    this._lastFfmpegArgs = [...ffmpegArgs];
    this.ffmpeg = await this._spawnProcess(this.ffmpegBin, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._bindPipelineErrorHandler(this.sourceProc.stdout, 'sourceProc.stdout');
    this._bindPipelineErrorHandler(this.sourceProc.stderr, 'sourceProc.stderr');
    this._bindPipelineErrorHandler(this.ffmpeg.stdin, 'ffmpeg.stdin');
    this._bindPipelineErrorHandler(this.ffmpeg.stdout, 'ffmpeg.stdout');
    this._bindPipelineErrorHandler(this.ffmpeg.stderr, 'ffmpeg.stderr');

    this.sourceProc.stdout.pipe(this.ffmpeg.stdin);
    this.sourceProc.once('close', () => {
      this.ffmpeg?.stdin?.end();
    });

    try {
      if (seekSec > 0) {
        const waitTimeoutMs = Math.min(45_000, 10_000 + (Math.max(0, Number.parseInt(String(seekSec), 10) || 0) * 50));
        await this._awaitProcessOutput(this.sourceProc, waitTimeoutMs);
      } else {
        await this._awaitYtDlpStartupGrace(this.sourceProc, 750);
      }
    } catch (err: unknown) {
      if (stderr.trim()) {
        throw new Error(stderr.trim().split('\n').slice(-2).join(' | '));
      }
      throw err;
    } finally {
      if (ytdlpVerboseEnabled) {
        const trailing = stderrBuffer.trim();
        if (trailing) {
          this.logger?.info?.('yt-dlp verbose', { line: trailing });
        }
      }
    }
  },

  _ffmpegArgs(seekSec = 0, options: { realtimeInput?: boolean } = {}) {
    const filterChain = this._buildTranscodeFilterChain();
    const seek = Math.max(0, Number.parseInt(String(seekSec), 10) || 0);
    const realtimeInput = options?.realtimeInput === true;
    const args = [
      ...(realtimeInput ? ['-re'] : []),
      '-thread_queue_size', '4096',
      '-i', 'pipe:0',
    ];

    if (seek > 0) {
      args.push('-ss', String(seek));
    }

    args.push(
      '-ac', '2',
      '-ar', '48000',
      ...(filterChain ? ['-af', filterChain] : []),
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    );

    return args;
  },

  _buildTranscodeFilterChain() {
    const filters = [];

    if (this.pitchSemitones !== 0) {
      const rateFactor = 2 ** (this.pitchSemitones / 12);
      filters.push(`asetrate=48000*${rateFactor.toFixed(6)}`);
      filters.push('aresample=48000');
    }

    if (this.tempoRatio !== 1) {
      filters.push(`atempo=${this.tempoRatio.toFixed(3)}`);
    }

    const presetFilters = FILTER_PRESETS[this.filterPreset] ?? FILTER_PRESETS.off ?? [];
    if (!isLiveFilterPresetSupported(this.filterPreset)) {
      filters.push(...presetFilters);
    }
    return filters.join(',');
  },

  isLiveFilterPresetSupported(name?: string) {
    return isLiveFilterPresetSupported(name ?? this.filterPreset);
  },

  _getLiveAudioProcessorState() {
    return {
      volumePercent: clamp(this.volumePercent, this.minVolumePercent, this.maxVolumePercent),
      filterPreset: this.isLiveFilterPresetSupported(this.filterPreset) ? this.filterPreset : 'off',
      eqPreset: this.eqPreset,
    };
  },

  _createLiveAudioProcessor() {
    return new LiveAudioProcessor(this._getLiveAudioProcessorState());
  },

  _createPlaybackOutputStream() {
    const output = new PassThrough();
    this._bindPipelineErrorHandler(output, 'playbackOutputStream');
    this.playbackOutputStream = output;
    return output;
  },

  _shouldUseLiveAudioProcessor() {
    const state = this._getLiveAudioProcessorState();
    return (
      state.volumePercent !== 100
      || state.filterPreset !== 'off'
      || state.eqPreset !== 'flat'
    );
  },

  _syncLiveAudioProcessor() {
    if (!this.liveAudioProcessor) return false;
    try {
      this.liveAudioProcessor.updateSettings(this._getLiveAudioProcessorState());
      return true;
    } catch (err) {
      this.logger?.warn?.('Failed to sync live audio processor state', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  _enableLiveAudioProcessorDuringPlayback() {
    if (this.liveAudioProcessor) {
      return this._syncLiveAudioProcessor();
    }

    const ffmpegOutput = this.ffmpeg?.stdout;
    const playbackOutput = this.playbackOutputStream;
    if (!ffmpegOutput?.pipe || !ffmpegOutput?.unpipe || !playbackOutput?.pipe) {
      return false;
    }

    const processor = this._createLiveAudioProcessor();
    this._bindPipelineErrorHandler(processor, 'liveAudioProcessor');

    try {
      ffmpegOutput.unpipe(playbackOutput);
      ffmpegOutput.pipe(processor);
      processor.pipe(playbackOutput);
      this.liveAudioProcessor = processor;
      return true;
    } catch (err) {
      try {
        ffmpegOutput.unpipe?.(processor);
      } catch {}
      try {
        processor.unpipe?.(playbackOutput);
      } catch {}
      try {
        processor.destroy?.();
      } catch {}
      this.liveAudioProcessor = null;
      this.logger?.warn?.('Failed to enable live audio processor during playback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  },

  async _spawnYtDlp(
    url: string,
    formatSelector: string | null = 'bestaudio/best',
    includeClientArg: boolean | string | null = true
  ) {
    const ytdlpVerboseEnabled = this._isYtDlpVerboseEnabled();
    const commonArgs = [
      '--ignore-config',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--retry-sleep', 'fragment:1:3',
    ];
    if (!ytdlpVerboseEnabled) {
      commonArgs.push('--quiet');
    }

    if (formatSelector) {
      commonArgs.push('-f', formatSelector);
    }

    const clientArg = this._resolveYtDlpClientArg(includeClientArg);
    if (clientArg) {
      commonArgs.push('--extractor-args', `youtube:player_client=${clientArg}`);
    }
    const activeCookiesFile = this._getActiveYtDlpCookiesFile?.() ?? null;
    if (activeCookiesFile) {
      commonArgs.push('--cookies', activeCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }
    if (this.ytdlpExtraArgs.length) {
      commonArgs.push(...(this.ytdlpExtraArgs as string[]));
    }

    commonArgs.push('-o', '-', url);
    const candidates: Array<[string, string[]]> = [];

    if (this.ytdlpBin) {
      candidates.push([this.ytdlpBin, commonArgs]);
    }

    candidates.push(
      ['yt-dlp', commonArgs],
      ['yt_dlp', commonArgs],
      ['py', ['-m', 'yt_dlp', ...commonArgs]],
      ['python', ['-m', 'yt_dlp', ...commonArgs]],
      ['python3', ['-m', 'yt_dlp', ...commonArgs]]
    );

    let lastErr: Error | null = null;
    for (const [cmd, args] of candidates) {
      try {
        return await this._spawnProcess(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err: unknown) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
          if (!lastErr) {
            lastErr = err instanceof Error ? err : new Error(String(err));
          }
          continue;
        }
        throw err;
      }
    }

    throw new Error(`yt-dlp not found (${lastErr?.message ?? 'command not available'})`);
  },

  _isYtDlpVerboseEnabled() {
    if (!Array.isArray(this.ytdlpExtraArgs) || !this.ytdlpExtraArgs.length) return false;
    return this.ytdlpExtraArgs.some((arg: unknown) => {
      const token = String(arg ?? '').trim();
      return token === '--verbose' || token === '-v';
    });
  },

  _trackYtDlpFormatSelection(stderrChunk: unknown) {
    const text = String(stderrChunk ?? '');
    if (!text) return;

    const selectedMatch = text.match(/Downloading\s+\d+\s+format\(s\):\s*([^\r\n]+)/i);
    if (selectedMatch?.[1]) {
      const selectedFormats = String(selectedMatch[1]).trim();
      const itagMatch = selectedFormats.match(/\b(\d{2,4})\b/);
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedFormats,
        selectedItag: itagMatch?.[1] ?? this._lastYtDlpDiagnostics?.selectedItag ?? null,
        updatedAt: new Date().toISOString(),
      };
      return;
    }

    const itagMatch = text.match(/[?&]itag=(\d{2,4})\b/i);
    if (itagMatch?.[1]) {
      this._lastYtDlpDiagnostics = {
        ...(this._lastYtDlpDiagnostics ?? {}),
        selectedItag: itagMatch[1],
        updatedAt: new Date().toISOString(),
      };
    }
  },

  async _searchWithYtDlp(query: string, limit = 1) {
    const safeLimit = Math.max(1, Math.min(10, Number.parseInt(String(limit), 10) || 1));
    const searchExpr = `ytsearch${safeLimit}:${query}`;
    const commonArgs = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--skip-download',
      '--dump-single-json',
    ];

    if (this.ytdlpYoutubeClient) {
      commonArgs.push('--extractor-args', `youtube:player_client=${this.ytdlpYoutubeClient}`);
    }
    const activeCookiesFile = this._getActiveYtDlpCookiesFile?.() ?? null;
    if (activeCookiesFile) {
      commonArgs.push('--cookies', activeCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      commonArgs.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }
    if (this.ytdlpExtraArgs.length) {
      commonArgs.push(...(this.ytdlpExtraArgs as string[]));
    }

    commonArgs.push(searchExpr);

    const { stdout } = await this._runYtDlpCommand(commonArgs, 15_000);

    if (!stdout?.trim()) return [];
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return [];
    }

    const entries = Array.isArray(payload?.entries)
      ? payload.entries
      : (payload ? [payload] : []);

    return entries
      .map((entry: YtDlpSearchEntry) => {
        const id = String(entry?.id ?? '').trim();
        const url = String(entry?.webpage_url ?? entry?.url ?? '').trim() || (id ? `https://www.youtube.com/watch?v=${id}` : null);
        const title = String(entry?.title ?? '').trim();
        if (!url || !title) return null;
        return {
          title,
          url,
          duration: entry?.duration ?? null,
          thumbnailUrl: pickThumbnailUrlFromItem(entry),
          artist: pickTrackArtistFromMetadata(entry),
        };
      })
      .filter(Boolean);
  },

  async _runYtDlpCommand(args: string[], timeoutMs = 12_000) {
    const nativeCandidates: string[] = [];
    if (this.ytdlpBin) nativeCandidates.push(this.ytdlpBin);
    nativeCandidates.push('yt-dlp', 'yt_dlp');
    const pythonCandidates = ['py', 'python', 'python3'];

    const tryCandidates = async (candidates: string[], options: { stopAfterFirstExecutionFailure?: boolean } = {}) => {
      const { stopAfterFirstExecutionFailure = false } = options;
      let lastErr: Error | null = null;

      for (const cmd of candidates) {
        let proc;
        try {
          if (isPythonModuleCommand(cmd)) {
            proc = await this._spawnProcess(cmd, ['-m', 'yt_dlp', ...args], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } else {
            proc = await this._spawnProcess(cmd, args, {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          }
        } catch (err: unknown) {
          if (isErrnoException(err) && err.code === 'ENOENT') {
            lastErr = err instanceof Error ? err : new Error(String(err));
            continue;
          }
          throw err;
        }

        const output = await this._collectProcessOutput(proc, timeoutMs);

        if (output.code === 0) return output;
        lastErr = new Error(output.stderr?.trim() || `yt-dlp exited with code ${output.code}`);
        if (stopAfterFirstExecutionFailure) {
          throw lastErr;
        }
      }

      throw lastErr ?? new Error('yt-dlp command failed');
    };

    try {
      return await tryCandidates(nativeCandidates, { stopAfterFirstExecutionFailure: true });
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return await tryCandidates(pythonCandidates);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  },

  async _probeHttpAudioTrack(url: string, timeoutMs = 15_000) {
    const ffprobeBin = this.ffmpegBin.endsWith('ffmpeg')
      ? this.ffmpegBin.replace(/ffmpeg(?:\.exe)?$/i, (match: string) => match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe';
    const args = [
      '-nostdin',
      '-user_agent', 'Mozilla/5.0 (compatible; FluxerBot/1.0)',
      '-v', 'error',
      '-show_entries', 'format=duration:stream=duration:format_tags=title,artist:stream_tags=title,artist',
      '-of', 'json',
      url,
    ];

    const proc = await this._spawnProcess(ffprobeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const { stdout } = await this._collectProcessOutput(proc, timeoutMs).catch(() => ({ stdout: '' }));
    if (!stdout?.trim()) return null;

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      return null;
    }

    const durationCandidates = [
      payload?.format?.duration,
      ...(Array.isArray(payload?.streams) ? payload.streams.map((stream: unknown) => {
        if (!stream || typeof stream !== 'object') return null;
        return (stream as { duration?: unknown }).duration ?? null;
      }) : []),
    ];
    const durationRaw = durationCandidates
      .map((value) => Number.parseFloat(String(value ?? '')))
      .find((value) => Number.isFinite(value) && value > 0) ?? null;
    const durationSec = typeof durationRaw === 'number' && durationRaw > 0
      ? Math.max(1, Math.round(durationRaw))
      : null;

    return {
      durationSec,
      title: String(payload?.format?.tags?.title ?? payload?.streams?.[0]?.tags?.title ?? '').trim() || null,
      artist: String(payload?.format?.tags?.artist ?? payload?.streams?.[0]?.tags?.artist ?? '').trim() || null,
    };
  },

  async _resolveYtDlpStreamUrl(
    url: string,
    formatSelector: string | null = 'bestaudio/best',
    includeClientArg: boolean | string | null = true
  ) {
    const args = [
      '--ignore-config',
      '--quiet',
      '--no-warnings',
      '--no-playlist',
    ];

    if (formatSelector) {
      args.push('-f', formatSelector);
    }
    const clientArg = this._resolveYtDlpClientArg(includeClientArg);
    if (clientArg) {
      args.push('--extractor-args', `youtube:player_client=${clientArg}`);
    }
    const activeCookiesFile = this._getActiveYtDlpCookiesFile?.() ?? null;
    if (activeCookiesFile) {
      args.push('--cookies', activeCookiesFile);
    }
    if (this.ytdlpCookiesFromBrowser) {
      args.push('--cookies-from-browser', this.ytdlpCookiesFromBrowser);
    }
    if (this.ytdlpExtraArgs.length) {
      args.push(...(this.ytdlpExtraArgs as string[]));
    }

    args.push('--get-url', url);

    const { stdout } = await this._runYtDlpCommand(args, 20_000);
    const lines = String(stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines[0] ?? null;
  },

  _collectProcessOutput(proc: ProcessOutputProc, timeoutMs = 12_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill?.('SIGKILL');
        reject(new Error('yt-dlp metadata command timed out.'));
      }, timeoutMs);

      proc.stdout?.setEncoding?.('utf8');
      proc.stderr?.setEncoding?.('utf8');
      proc.stdout?.on?.('data', (chunk: unknown) => {
        stdout = `${stdout}${chunk}`.slice(-2_000_000);
      });
      proc.stderr?.on?.('data', (chunk: unknown) => {
        stderr = `${stderr}${chunk}`.slice(-8_192);
      });

      proc.once?.('error', (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });

      proc.once?.('close', (code: unknown, signal: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const exitCode = typeof code === 'number' && Number.isFinite(code) ? code : 1;
        if (signal) {
          reject(new Error(`yt-dlp metadata command terminated by signal ${signal}.`));
          return;
        }
        resolve({ code: exitCode, stdout, stderr });
      });
    });
  },

  _awaitProcessOutput(proc: ProcessOutputProc, timeoutMs = 5_000) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sawOutput = false;
      const timeout = setTimeout(() => {
        if (settled || sawOutput) return;
        cleanup();
        reject(new Error('yt-dlp did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        sawOutput = true;
        if (settled) return;
        cleanup();
        resolve();
      };

      const onClose = (code: unknown, signal: unknown) => {
        if (settled || sawOutput) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`yt-dlp exited before output (code=${codeLabel}${signalLabel}).`));
      };

      const onError = (err: unknown) => {
        if (settled || sawOutput) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        proc.stdout?.off?.('data', onData);
        proc.off?.('close', onClose);
        proc.off?.('error', onError);
      };

      proc.stdout?.on?.('data', onData);
      proc.on?.('close', onClose);
      proc.on?.('error', onError);
    });
  },

  _awaitYtDlpStartupGrace(proc: ProcessOutputProc, timeoutMs = 750) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        cleanup();
        resolve();
      }, Math.max(0, timeoutMs));

      const onData = () => {
        if (settled) return;
        cleanup();
        resolve();
      };

      const onClose = (code: unknown, signal: unknown) => {
        if (settled) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`yt-dlp exited before startup grace completed (code=${codeLabel}${signalLabel}).`));
      };

      const onError = (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        proc.stdout?.off?.('data', onData);
        proc.off?.('close', onClose);
        proc.off?.('error', onError);
      };

      proc.stdout?.on?.('data', onData);
      proc.on?.('close', onClose);
      proc.on?.('error', onError);
    });
  },

  _awaitInitialPlaybackChunk(stream: ProcessOutputProc['stdout'], proc: ProcessOutputProc | null | undefined, timeoutMs = 8_000) {
    if (!stream?.once || !stream?.off) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error('Playback pipeline did not produce audio output in time.'));
      }, timeoutMs);

      const onData = () => {
        if (settled) return;
        cleanup();
        resolve();
      };

      const onStreamError = (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcError = (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onProcClose = (code: unknown, signal: unknown) => {
        if (settled) return;
        cleanup();
        const codeLabel = code == null ? 'unknown' : String(code);
        const signalLabel = signal ? `, signal=${signal}` : '';
        reject(new Error(`Playback pipeline exited before audio output (code=${codeLabel}${signalLabel}).`));
      };

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        stream.off?.('data', onData);
        stream.off?.('error', onStreamError);
        proc?.off?.('error', onProcError);
        proc?.off?.('close', onProcClose);
      };

      stream.once?.('data', onData);
      stream.once?.('error', onStreamError);
      proc?.once?.('error', onProcError);
      proc?.once?.('close', onProcClose);
    });
  },

  _getInitialPlaybackChunkTimeoutMs(
    track: { seekStartSec?: unknown; source?: unknown; url?: unknown; startupRetryCount?: unknown } | null | undefined,
    options: { hint?: string | null } = { hint: null }
  ) {
    const seekSec = Math.max(0, Number.parseInt(String(track?.seekStartSec ?? 0), 10) || 0);
    const normalizedHint = String(options?.hint ?? '').trim().toLowerCase();
    const isYouTubeTrack = String(track?.source ?? '').startsWith('youtube')
      || /(?:youtube\.com|youtu\.be)/i.test(String(track?.url ?? ''));
    const startupRetryAttempt = Math.max(0, Number.parseInt(String(track?.startupRetryCount ?? 0), 10) || 0);
    if (seekSec <= 0) {
      if (normalizedHint === 'skip') {
        return isYouTubeTrack
          ? 10_000 + (startupRetryAttempt * 10_000)
          : 6_000;
      }
      return isYouTubeTrack
        ? 12_000 + (startupRetryAttempt * 10_000)
        : 8_000;
    }

    return Math.min(60_000, 8_000 + (seekSec * 10));
  },

  _spawnProcess(cmd: string, args: string[], options: Parameters<typeof spawn>[2]): Promise<ProcessOutputProc> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, options);
      let settled = false;

      proc.once('spawn', () => {
        settled = true;
        resolve(proc as ProcessOutputProc);
      });

      proc.once('error', (err: unknown) => {
        if (!settled) {
          reject(err);
        }
      });
    });
  },
};
