import { beforeEach, describe, expect, it } from 'vitest';
import { borderPage, createShareBorder, type BorderWindow, type ShareBorder } from './share-border';
import type { Display, Rectangle } from 'electron';

const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } } as Display;
const SECOND = { id: 2, bounds: { x: -2560, y: -200, width: 2560, height: 1440 } } as Display;

let windows: FakeWindow[];
let border: ShareBorder;

class FakeWindow implements BorderWindow {
  bounds: Rectangle;
  visible = false;
  destroyed = false;
  urls: string[] = [];
  ignoreMouse = false;
  onTop = false;
  allWorkspaces = false;

  constructor(bounds: Rectangle) {
    this.bounds = bounds;
  }
  setBounds(bounds: Rectangle) {
    this.bounds = bounds;
  }
  setIgnoreMouseEvents(ignore: boolean) {
    this.ignoreMouse = ignore;
  }
  setAlwaysOnTop(top: boolean) {
    this.onTop = top;
  }
  setVisibleOnAllWorkspaces(visible: boolean) {
    this.allWorkspaces = visible;
  }
  async loadURL(url: string) {
    this.urls.push(url);
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}

const decoded = (url: string) => decodeURIComponent(url.replace('data:text/html;charset=utf-8,', ''));

beforeEach(() => {
  windows = [];
  border = createShareBorder({
    createWindow: (bounds) => {
      const window = new FakeWindow(bounds);
      windows.push(window);
      return window;
    },
    displayFor: (sourceId) =>
      sourceId === 'screen:1:0' ? PRIMARY : sourceId === 'screen:2:0' ? SECOND : undefined,
  });
});

describe('the border around a shared screen', () => {
  it('frames the display actually being shared', () => {
    border.update({ sourceId: 'screen:2:0', state: 'sharing' });

    expect(windows).toHaveLength(1);
    // The second display has a negative origin; the frame must land on it, not
    // on the primary.
    expect(windows[0]!.bounds).toEqual(SECOND.bounds);
    expect(windows[0]!.visible).toBe(true);
    expect(border.state()).toBe('sharing');
  });

  it('cannot be clicked, lost behind a window, or left in another space', () => {
    border.update({ sourceId: 'screen:1:0', state: 'sharing' });
    const window = windows[0]!;

    // An indicator you can lose is not an indicator.
    expect(window.ignoreMouse).toBe(true);
    expect(window.onTop).toBe(true);
    expect(window.allWorkspaces).toBe(true);
  });

  it('does not change when people take control', () => {
    border.update({ sourceId: 'screen:1:0', state: 'sharing' });
    const first = decoded(windows[0]!.urls.at(-1)!);
    const loads = windows[0]!.urls.length;

    // Several people hold cursors and send input at once, funnelled through
    // this machine's one mouse and keyboard. That is the point of the feature,
    // not an emergency - a border that went red for it would be red all
    // session, and an alarm that is always on is not an alarm.
    border.update({ sourceId: 'screen:1:0', state: 'sharing' });

    expect(windows[0]!.urls.length).toBe(loads);
    expect(first).toContain('You are sharing this screen');
    expect(first).not.toMatch(/controlling|#ff4d64|animation/);
  });

  it('goes away when sharing stops', () => {
    border.update({ sourceId: 'screen:1:0', state: 'sharing' });
    border.update({ state: 'hidden' });

    expect(windows[0]!.visible).toBe(false);
    expect(border.state()).toBe('hidden');
  });

  it('refuses to frame a display it cannot find', () => {
    // A frame in the wrong place is a lie about what people can see.
    border.update({ sourceId: 'screen:99:0', state: 'sharing' });
    expect(windows).toHaveLength(0);
    expect(border.state()).toBe('hidden');
  });

  it('follows the share from one display to another', () => {
    border.update({ sourceId: 'screen:1:0', state: 'sharing' });
    border.update({ sourceId: 'screen:2:0', state: 'sharing' });

    expect(windows).toHaveLength(1);
    expect(windows[0]!.bounds).toEqual(SECOND.bounds);
  });

  it('shows nothing of what is on the screen it frames', () => {
    const page = borderPage(PRIMARY.bounds);
    const html = decoded(page);
    // No capture, no thumbnail, no preview: a border reads no pixels.
    expect(html).not.toMatch(/img|canvas|video|desktopCapturer|getUserMedia/);
    expect(html).toContain('border');
  });
});
