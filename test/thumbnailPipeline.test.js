import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEmbed } from '../src/bot/messageFormatter.js';
import { MusicPlayer } from '../src/player/MusicPlayer.js';

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
