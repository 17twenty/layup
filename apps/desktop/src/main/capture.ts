import type { Logger } from './logging';

/**
 * Desktop capture source enumeration.
 *
 * Electron's desktopCapturer runs in the privileged process; the renderer only
 * ever receives a description of what can be shared, never a handle to it. The
 * renderer then asks Chromium for the stream by id (ARCHITECTURE.md §8).
 *
 * Thumbnails are screen pixels: they are shown in the picker and never logged,
 * stored or sent anywhere (SPEC.md §13.4).
 */
export type CaptureKind = 'screen' | 'window';

export interface CaptureSource {
  id: string;
  name: string;
  kind: CaptureKind;
  /** Data URL of a small preview, for the picker only. */
  thumbnailDataUrl?: string;
  displayId?: string;
}

/** The slice of Electron's desktopCapturer this needs. */
export interface DesktopCapturerLike {
  getSources(options: {
    types: string[];
    thumbnailSize?: { width: number; height: number };
    fetchWindowIcons?: boolean;
  }): Promise<
    Array<{
      id: string;
      name: string;
      display_id?: string;
      thumbnail?: { isEmpty(): boolean; toDataURL(): string };
    }>
  >;
}

export interface CaptureServiceOptions {
  desktopCapturer: DesktopCapturerLike;
  log: Logger;
  thumbnailSize?: { width: number; height: number };
}

export interface CaptureService {
  listSources(): Promise<CaptureSource[]>;
}

export function createCaptureService(options: CaptureServiceOptions): CaptureService {
  const size = options.thumbnailSize ?? { width: 320, height: 200 };

  return {
    async listSources() {
      const raw = await options.desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: size,
      });

      const sources: CaptureSource[] = [];
      for (const entry of raw) {
        const kind: CaptureKind = entry.id.startsWith('screen:') ? 'screen' : 'window';
        // A window with no title is almost always an OS artefact, not
        // something a person means to share.
        if (kind === 'window' && entry.name.trim() === '') continue;

        const source: CaptureSource = { id: entry.id, name: entry.name, kind };
        if (entry.display_id) source.displayId = entry.display_id;
        if (entry.thumbnail && !entry.thumbnail.isEmpty()) {
          source.thumbnailDataUrl = entry.thumbnail.toDataURL();
        }
        sources.push(source);
      }

      // Screens first: sharing a whole display is the common case.
      sources.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1));

      // Count and kinds only - never names of windows, never pixels.
      options.log.info('capture sources enumerated', {
        screens: sources.filter((s) => s.kind === 'screen').length,
        windows: sources.filter((s) => s.kind === 'window').length,
      });
      return sources;
    },
  };
}
