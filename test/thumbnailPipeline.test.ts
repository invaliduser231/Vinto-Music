import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbed } from '../src/bot/messageFormatter.ts';
import { MusicPlayer } from '../src/player/MusicPlayer.ts';

test('buildEmbed includes thumbnail when a valid URL is provided', () => {
  const embed = buildEmbed({
    title: 'Now Playing',
    description: 'Track',
    thumbnailUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
  });

  assert.equal(embed.thumbnail?.url, 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
});

test('buildEmbed includes image when a valid URL is provided', () => {
  const embed = buildEmbed({
    title: 'Now Playing',
    description: 'Track',
    imageUrl: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg',
  });

  assert.equal(embed.image?.url, 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg');
});

test('music player infers YouTube thumbnail when missing', () => {
  const player = new MusicPlayer({}, { logger: null });
  const track = player._buildTrack({
    title: 'Track',
    url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
    duration: 123,
    source: 'youtube',
    requestedBy: 'user-1',
  });

  assert.equal(track.thumbnailUrl, 'https://i.ytimg.com/vi/QX_VR_Wshvk/hqdefault.jpg');
});

test('createTrackFromData preserves explicit thumbnail URL', () => {
  const player = new MusicPlayer({}, { logger: null });
  const track = player.createTrackFromData({
    title: 'Stored',
    url: 'https://www.youtube.com/watch?v=QX_VR_Wshvk',
    duration: '2:03',
    source: 'stored',
    thumbnailUrl: 'https://cdn.example.com/stored.jpg',
  }, 'user-2');

  assert.equal(track.thumbnailUrl, 'https://cdn.example.com/stored.jpg');
});

test('createTrackFromData resolves thumbnail from fallback metadata fields', () => {
  const player = new MusicPlayer({}, { logger: null });
  const track = player.createTrackFromData({
    title: 'Stored with artwork',
    url: 'https://example.com/audio',
    duration: '2:03',
    source: 'stored',
    artwork_url: 'https://cdn.example.com/artwork.jpg',
  }, 'user-3');

  assert.equal(track.thumbnailUrl, 'https://cdn.example.com/artwork.jpg');
});

test('createTrackFromData resolves Deezer album cover fallback fields', () => {
  const player = new MusicPlayer({}, { logger: null });
  const track = player.createTrackFromData({
    title: 'Stored Deezer Track',
    url: 'https://www.deezer.com/track/123456',
    duration: '2:03',
    source: 'stored',
    album: {
      cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/abc123/1000x1000-000000-80-0-0.jpg',
    },
  }, 'user-4');

  assert.equal(track.thumbnailUrl, 'https://e-cdns-images.dzcdn.net/images/cover/abc123/1000x1000-000000-80-0-0.jpg');
});





