import type { LayupApi } from '../preload/api';

declare global {
  interface Window {
    /** The entire privileged surface available to the renderer. */
    readonly layup: LayupApi;
  }
}

export {};
