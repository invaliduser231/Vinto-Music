import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const AUDIO_CAPTURE_THREAD_PREFIX = 'AudioSourceCapt';
export const AUDIO_THREAD_WATCHDOG_INTERVAL_MS = 60_000;
export const AUDIO_THREAD_WATCHDOG_REQUIRED_BREACHES = 2;

export interface AudioThreadWatchdogPolicy {
  idleRestartLeakedThreads: number;
  restartLeakedThreads: number;
}

export interface AudioThreadWatchdogSample {
  captureThreads: number;
  voiceConnectionsConnected: number;
  playersPlaying: number;
}

export type AudioThreadWatchdogVerdict = 'ok' | 'breach_idle' | 'breach';

export async function countAudioCaptureThreads(taskDir = '/proc/self/task'): Promise<number | null> {
  let taskIds: string[];
  try {
    taskIds = await readdir(taskDir);
  } catch {
    return null;
  }

  const names = await Promise.all(taskIds.map((taskId) => (
    readFile(join(taskDir, taskId, 'comm'), 'utf8').catch(() => '')
  )));
  return names.filter((name) => name.startsWith(AUDIO_CAPTURE_THREAD_PREFIX)).length;
}

export function leakedAudioThreads(sample: AudioThreadWatchdogSample): number {
  return Math.max(0, sample.captureThreads - sample.voiceConnectionsConnected);
}

export function evaluateAudioThreadWatchdog(
  policy: AudioThreadWatchdogPolicy,
  sample: AudioThreadWatchdogSample,
): AudioThreadWatchdogVerdict {
  const leaked = leakedAudioThreads(sample);
  if (policy.restartLeakedThreads > 0 && leaked >= policy.restartLeakedThreads) return 'breach';
  if (
    policy.idleRestartLeakedThreads > 0
    && leaked >= policy.idleRestartLeakedThreads
    && sample.playersPlaying === 0
  ) {
    return 'breach_idle';
  }
  return 'ok';
}
