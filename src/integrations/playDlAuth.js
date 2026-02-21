import playdl from 'play-dl';

export async function initializePlayDlAuth(config, logger) {
  const tokenOptions = {};

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
    tokenOptions.spotify = {
      client_id: config.spotifyClientId,
      client_secret: config.spotifyClientSecret,
      refresh_token: config.spotifyRefreshToken,
      market: config.spotifyMarket,
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
