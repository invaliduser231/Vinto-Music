import playdl from 'play-dl';
import type { LoggerLike } from '../types/core.ts';

interface PlayDlInitConfig {
  soundcloudClientId?: string | null;
  soundcloudAutoClientId?: boolean;
  strictMediaAuth?: boolean;
  spotifyClientId?: string | null;
  spotifyClientSecret?: string | null;
  spotifyRefreshToken?: string | null;
  spotifyMarket?: string | null;
}

interface PlayDlTokenOptions {
  soundcloud?: {
    client_id: string;
  };
  spotify?: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    market: string;
  };
}

export async function initializePlayDlAuth(config: PlayDlInitConfig, logger?: LoggerLike) {
  const tokenOptions: PlayDlTokenOptions = {};

  if (config.soundcloudClientId) {
    tokenOptions.soundcloud = {
      client_id: config.soundcloudClientId,
    };
  } else if (config.soundcloudAutoClientId) {
    try {
      const autoClientId = await playdl.getFreeClientID();
      if (autoClientId) {
        tokenOptions.soundcloud = { client_id: autoClientId };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (config.strictMediaAuth) {
        throw new Error(`Failed to auto-resolve SoundCloud client ID: ${message}`);
      }
      logger?.warn?.('Failed to auto-resolve SoundCloud client ID', { error: message });
    }
  }

  const spotifyConfigured = Boolean(
    config.spotifyClientId
    && config.spotifyClientSecret
    && config.spotifyRefreshToken
  );

  if (spotifyConfigured) {
    const spotifyClientId = config.spotifyClientId!;
    const spotifyClientSecret = config.spotifyClientSecret!;
    const spotifyRefreshToken = config.spotifyRefreshToken!;
    tokenOptions.spotify = {
      client_id: spotifyClientId,
      client_secret: spotifyClientSecret,
      refresh_token: spotifyRefreshToken,
      market: config.spotifyMarket ?? 'US',
    };
  }

  const hasAnyProvider = Boolean(tokenOptions.spotify || tokenOptions.soundcloud);
  if (!hasAnyProvider) {
    logger?.warn?.('No Spotify/SoundCloud auth configured for play-dl. URL support may be limited.');
    return;
  }

  try {
    await playdl.setToken(tokenOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (config.strictMediaAuth) {
      throw new Error(`play-dl token setup failed: ${message}`);
    }

    logger?.warn?.('play-dl token setup failed', {
      error: message,
      spotifyConfigured: Boolean(tokenOptions.spotify),
      soundcloudConfigured: Boolean(tokenOptions.soundcloud),
    });
    return;
  }

  logger?.info?.('play-dl auth configured', {
    spotifyConfigured: Boolean(tokenOptions.spotify),
    soundcloudConfigured: Boolean(tokenOptions.soundcloud),
    spotifyMarket: tokenOptions.spotify?.market ?? null,
  });
}




