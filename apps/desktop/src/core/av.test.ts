import { describe, expect, it, vi } from 'vitest';
import { createAvController } from './av';

function fakeTrack(kind: 'video' | 'audio') {
  return { kind, enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream() {
  const video = fakeTrack('video');
  const audio = fakeTrack('audio');
  const stream = {
    getTracks: () => [video, audio],
    getVideoTracks: () => [video],
    getAudioTracks: () => [audio],
  } as unknown as MediaStream;
  return { stream, video, audio };
}

function harness(getUserMedia?: () => Promise<MediaStream>) {
  const media = fakeStream();
  const controller = createAvController({
    getUserMedia: vi.fn(getUserMedia ?? (async () => media.stream)),
    onChange: () => {},
  });
  return { controller, media };
}

describe('camera and microphone', () => {
  it('refuses to start without a membership', async () => {
    const h = harness();
    const state = await h.controller.start('', { camera: true, microphone: true });

    // Clicking a person must never open the camera; media follows acceptance.
    expect(state.stream).toBeUndefined();
    expect(state.error).toMatch(/accept first/);
  });

  it('starts with the join policy applied', async () => {
    const h = harness();
    const state = await h.controller.start('mem_1', { camera: true, microphone: false });

    expect(state.stream).toBeTruthy();
    expect(h.media.video.enabled).toBe(true);
    expect(h.media.audio.enabled).toBe(false);
    expect(state.muted).toBe(true);
  });

  it('mutes by disabling the track, not by stopping it', async () => {
    const h = harness();
    await h.controller.start('mem_1', { camera: true, microphone: true });

    h.controller.setMicrophone(false);
    expect(h.media.audio.enabled).toBe(false);
    // Stopping would force a renegotiation to come back.
    expect(h.media.audio.stop).not.toHaveBeenCalled();

    h.controller.setMicrophone(true);
    expect(h.media.audio.enabled).toBe(true);
    expect(h.controller.state().muted).toBe(false);
  });

  it('toggles the camera the same way', async () => {
    const h = harness();
    await h.controller.start('mem_1', { camera: true, microphone: true });

    h.controller.setCamera(false);
    expect(h.media.video.enabled).toBe(false);
    expect(h.media.video.stop).not.toHaveBeenCalled();
  });

  it('is idempotent for the same membership', async () => {
    const h = harness();
    const first = await h.controller.start('mem_1', { camera: true, microphone: true });
    const second = await h.controller.start('mem_1', { camera: false, microphone: false });
    expect(second.stream).toBe(first.stream);
  });

  it('releases the devices on stop', async () => {
    const h = harness();
    await h.controller.start('mem_1', { camera: true, microphone: true });
    const state = h.controller.stop();

    expect(h.media.video.stop).toHaveBeenCalled();
    expect(h.media.audio.stop).toHaveBeenCalled();
    expect(state.stream).toBeUndefined();
  });

  it('explains each device failure in words a person can act on', async () => {
    for (const [name, expected] of [
      ['NotAllowedError', /permission was refused/],
      ['NotFoundError', /no camera or microphone was found/],
      ['NotReadableError', /already in use by another application/],
    ] as const) {
      const error = new Error('device failure');
      error.name = name;
      const h = harness(async () => {
        throw error;
      });
      const state = await h.controller.start('mem_1', { camera: true, microphone: true });
      expect(state.error).toMatch(expected);
      expect(state.stream).toBeUndefined();
    }
  });
});
