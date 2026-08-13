import { describe, expect, it, vi } from 'vitest';
import { createCaptureService, type DesktopCapturerLike } from './capture';
import { createLogger } from './logging';

const thumbnail = (data: string, empty = false) => ({
  isEmpty: () => empty,
  toDataURL: () => data,
});

function harness(entries: Parameters<typeof fakeCapturer>[0]) {
  const lines: string[] = [];
  const service = createCaptureService({
    desktopCapturer: fakeCapturer(entries),
    log: createLogger({ level: 'debug', write: (line) => lines.push(line) }),
  });
  return { service, lines };
}

function fakeCapturer(
  entries: Array<{
    id: string;
    name: string;
    display_id?: string;
    thumbnail?: ReturnType<typeof thumbnail>;
  }>,
): DesktopCapturerLike {
  return { getSources: vi.fn(async () => entries) };
}

describe('capture source enumeration', () => {
  it('describes screens and windows, screens first', async () => {
    const h = harness([
      { id: 'window:12:0', name: 'Editor', thumbnail: thumbnail('data:image/png;base64,WIN') },
      {
        id: 'screen:1:0',
        name: 'Entire Screen',
        display_id: '69733382',
        thumbnail: thumbnail('data:image/png;base64,SCREEN'),
      },
    ]);

    const sources = await h.service.listSources();
    expect(sources.map((s) => s.kind)).toEqual(['screen', 'window']);
    expect(sources[0]).toMatchObject({
      id: 'screen:1:0',
      name: 'Entire Screen',
      displayId: '69733382',
      thumbnailDataUrl: 'data:image/png;base64,SCREEN',
    });
    expect(sources[1]).toMatchObject({ id: 'window:12:0', kind: 'window' });
  });

  it('drops untitled windows, which are OS artefacts rather than choices', async () => {
    const h = harness([
      { id: 'window:1:0', name: '   ' },
      { id: 'window:2:0', name: 'Terminal' },
    ]);
    const sources = await h.service.listSources();
    expect(sources.map((s) => s.name)).toEqual(['Terminal']);
  });

  it('omits an empty thumbnail rather than sending a blank image', async () => {
    const h = harness([{ id: 'screen:1:0', name: 'Entire Screen', thumbnail: thumbnail('', true) }]);
    const [source] = await h.service.listSources();
    expect(source?.thumbnailDataUrl).toBeUndefined();
  });

  it('never logs window names or pixels', async () => {
    const h = harness([
      { id: 'screen:1:0', name: 'Entire Screen', thumbnail: thumbnail('data:image/png;base64,PIXELS') },
      { id: 'window:9:0', name: 'Password Manager' },
    ]);
    await h.service.listSources();

    const logged = h.lines.join('\n');
    expect(logged).not.toMatch(/Password Manager|PIXELS|data:image/);
    expect(JSON.parse(h.lines[0]!)).toMatchObject({ screens: 1, windows: 1 });
  });
});
