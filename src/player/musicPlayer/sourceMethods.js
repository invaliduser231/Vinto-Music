import { audiusMethods } from './audiusMethods.js';
import { deezerMethods } from './deezerMethods.js';
import { soundcloudMethods } from './soundcloudMethods.js';
import { trackFactoryMethods } from './trackFactoryMethods.js';
import { urlResolverMethods } from './urlResolverMethods.js';

export const sourceMethods = {
  ...trackFactoryMethods,
  ...audiusMethods,
  ...soundcloudMethods,
  ...deezerMethods,
  ...urlResolverMethods,
};
