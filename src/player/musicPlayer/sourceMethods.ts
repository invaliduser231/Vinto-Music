import { amazonMethods } from './amazonMethods.ts';
import { appleMethods } from './appleMethods.ts';
import { audiusMethods } from './audiusMethods.ts';
import { deezerMethods } from './deezerMethods.ts';
import { soundcloudMethods } from './soundcloudMethods.ts';
import { spotifyMethods } from './spotifyMethods.ts';
import { trackFactoryMethods } from './trackFactoryMethods.ts';
import { urlResolverMethods } from './urlResolverMethods.ts';

export const sourceMethods = {
  ...amazonMethods,
  ...appleMethods,
  ...trackFactoryMethods,
  ...audiusMethods,
  ...soundcloudMethods,
  ...deezerMethods,
  ...urlResolverMethods,
  ...spotifyMethods,
};


