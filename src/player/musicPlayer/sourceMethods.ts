import { audiusMethods } from './audiusMethods.ts';
import { deezerMethods } from './deezerMethods.ts';
import { soundcloudMethods } from './soundcloudMethods.ts';
import { trackFactoryMethods } from './trackFactoryMethods.ts';
import { urlResolverMethods } from './urlResolverMethods.ts';

export const sourceMethods = {
  ...trackFactoryMethods,
  ...audiusMethods,
  ...soundcloudMethods,
  ...deezerMethods,
  ...urlResolverMethods,
};
