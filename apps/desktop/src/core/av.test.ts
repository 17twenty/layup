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

describe('the devices somebody chose', () => {
  /** A stream whose tracks can actually be swapped, as a real one can. */
  function switchableStream(id: string) {
    let tracks = [fakeTrack('video'), fakeTrack('audio')];
    return {
      id,
      getTracks: () => [...tracks],
      getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
      getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
      addTrack: (track: MediaStreamTrack) => tracks.push(track),
      removeTrack: (track: MediaStreamTrack) => (tracks = tracks.filter((entry) => entry !== track)),
    } as unknown as MediaStream & { id: string };
  }

  it('is remembered across a leave and a rejoin', async () => {
    const asked: MediaStreamConstraints[] = [];
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      asked.push(constraints);
      return switchableStream('s');
    });
    const controller = createAvController({ getUserMedia });

    await controller.start('mem_1', { camera: true, microphone: true });
    await controller.setMicrophoneDevice('mic_usb');
    controller.setSpeaker('spk_1');
    controller.stop();
    const state = await controller.start('mem_2', { camera: true, microphone: true });

    expect(asked.at(-1)).toEqual({ audio: { deviceId: { exact: 'mic_usb' } }, video: true });
    expect(state.microphoneId).toBe('mic_usb');
    // Output too: it is a preference about this machine, not about one call.
    expect(state.speakerId).toBe('spk_1');
  });

  it('joins on the default when a remembered device is not plugged in', async () => {
    let attempt = 0;
    const asked: MediaStreamConstraints[] = [];
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      asked.push(constraints);
      attempt += 1;
      // The first call opens the devices; the third is the rejoin, where the
      // remembered microphone is no longer there.
      if (attempt === 3) {
        const error = new Error('gone');
        error.name = 'OverconstrainedError';
        throw error;
      }
      return switchableStream(`s${attempt}`);
    });
    const controller = createAvController({ getUserMedia });

    await controller.start('mem_1', { camera: true, microphone: true });
    await controller.setMicrophoneDevice('mic_usb');
    controller.stop();
    const state = await controller.start('mem_2', { camera: true, microphone: true });

    // Joining with no media at all because of a preference would be worse than
    // the preference being quietly dropped.
    expect(state.stream).toBeTruthy();
    expect(state.error).toBeUndefined();
    expect(state.microphoneId).toBeUndefined();
    expect(asked.at(-1)).toEqual({ audio: true, video: true });
  });
});
