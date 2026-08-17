/**
 * Camera and microphone for a layup.
 *
 * Media starts only after a membership exists (SPEC.md §4): clicking a person
 * creates a request, and nothing opens the camera until that request has been
 * accepted. `start()` therefore takes the membership it is starting for, and
 * refuses without one.
 */
export interface AvPreferences {
  /** Camera on at join, subject to policy and the person's own preference. */
  camera: boolean;
  /** Microphone on at join; false means joined muted, not "no microphone". */
  microphone: boolean;
}

export interface AvState {
  /** Present once devices have been opened. */
  stream?: MediaStream;
  cameraEnabled: boolean;
  microphoneEnabled: boolean;
  /** True when the person is muted, for the indicator. */
  muted: boolean;
  /** Why capture is unavailable, when it is. */
  error?: string;
  membershipId?: string;
  /** The chosen microphone; undefined means whatever the system defaults to. */
  microphoneId?: string;
  cameraId?: string;
  /** The chosen speaker, applied to the media elements by the UI. */
  speakerId?: string;
  /** Set when a chosen device was gone and the default was used instead. */
  deviceNotice?: string;
}

export interface AvOptions {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  onChange?: (state: AvState) => void;
  /**
   * A replacement capture track, to be swapped into the sender that is already
   * publishing that kind - `RTCRtpSender.replaceTrack` and nothing else.
   *
   * Adding or removing a track renegotiates, and a renegotiation mid-call is
   * what this release exists to stop: it takes the media elements down and the
   * audio with them.
   */
  onTrackReplaced?: (track: MediaStreamTrack) => void;
  log?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface AvController {
  state(): AvState;
  /** Opens devices for a membership. Idempotent for the same membership. */
  start(membershipId: string, preferences: AvPreferences): Promise<AvState>;
  setCamera(enabled: boolean): AvState;
  setMicrophone(enabled: boolean): AvState;
  /**
   * Changes which microphone is captured, without renegotiating: open the new
   * device, hand the track to the sender that is already there, then release
   * the old one. `undefined` means the system default.
   */
  setMicrophoneDevice(deviceId?: string): Promise<AvState>;
  /** The same, for the camera. */
  setCameraDevice(deviceId?: string): Promise<AvState>;
  /** Records the chosen speaker. Output is applied to the media elements. */
  setSpeaker(deviceId?: string): AvState;
  /** Releases the devices. The layup itself is unaffected. */
  stop(): AvState;
}

const noopLog = { info: () => {}, warn: () => {} };

export function createAvController(options: AvOptions): AvController {
  const log = options.log ?? noopLog;
  let state: AvState = { cameraEnabled: false, microphoneEnabled: false, muted: true };

  const publish = () => {
    options.onChange?.(state);
    return state;
  };

  const applyTracks = () => {
    // Muting is `enabled = false`, not stopping the track: the track keeps its
    // place in the peer connection so unmuting is instant and needs no
    // renegotiation.
    state.stream?.getVideoTracks().forEach((track) => (track.enabled = state.cameraEnabled));
    state.stream?.getAudioTracks().forEach((track) => (track.enabled = state.microphoneEnabled));
    state.muted = !state.microphoneEnabled;
  };

  /**
   * Swaps one capture device for another, mid-call, without renegotiating.
   *
   * The order is the whole point: open the new device, hand the track to the
   * sender that already exists, *then* stop the old one. Nothing is added to
   * or removed from the peer connection, so no offer is ever created - see
   * `device-switch.test.ts`, which fails if one is.
   */
  async function switchInput(kind: 'audio' | 'video', deviceId?: string): Promise<AvState> {
    const stream = state.stream;
    // Nothing is published yet, so there is nothing to swap: the choice would
    // have no sender to land in.
    if (!stream) return state;

    let replacement: MediaStream;
    let fellBack = false;
    try {
      replacement = await options.getUserMedia({ [kind]: constrain(deviceId) });
    } catch (error) {
      if (!deviceId) {
        state = { ...state, error: describeDeviceFailure(error) };
        log.warn('could not change device', { kind, reason: state.error });
        return publish();
      }
      // The chosen device has gone - unplugged, or taken by something else.
      // Falling back to the default beats leaving a dead track in the sender,
      // which is silence nobody in the call can explain.
      try {
        replacement = await options.getUserMedia({ [kind]: true });
        fellBack = true;
      } catch (fallbackError) {
        // Keep the device we already have: a microphone you did not pick still
        // carries your voice.
        state = { ...state, error: describeDeviceFailure(fallbackError) };
        log.warn('could not change device', { kind, reason: state.error });
        return publish();
      }
    }

    const [next] = kind === 'audio' ? replacement.getAudioTracks() : replacement.getVideoTracks();
    if (!next) {
      state = { ...state, error: 'that device produced no track' };
      return publish();
    }

    // Mute belongs to the person, not to the device they chose.
    next.enabled = kind === 'audio' ? state.microphoneEnabled : state.cameraEnabled;

    // Into the existing sender first, so the far side never hears a gap.
    options.onTrackReplaced?.(next);

    // Same MediaStream object throughout: the tiles hold it as `srcObject`,
    // and replacing that object is how media elements come to remount.
    const previous = kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks();
    stream.addTrack?.(next);
    for (const track of previous) {
      stream.removeTrack?.(track);
      track.stop();
    }

    state = {
      ...state,
      error: undefined,
      ...(kind === 'audio'
        ? { microphoneId: fellBack ? undefined : deviceId }
        : { cameraId: fellBack ? undefined : deviceId }),
      deviceNotice: fellBack
        ? `that ${kind === 'audio' ? 'microphone' : 'camera'} is no longer available - using the default`
        : undefined,
    };
    applyTracks();
    log.info('device changed without renegotiating', {
      kind,
      deviceId: state[kind === 'audio' ? 'microphoneId' : 'cameraId'] ?? 'default',
    });
    return publish();
  }

  return {
    state: () => state,

    async start(membershipId, preferences) {
      if (!membershipId) {
        state = { ...state, error: 'media needs a membership: accept first, then media starts' };
        return publish();
      }
      if (state.stream && state.membershipId === membershipId) return state;

      const remembered = Boolean(state.microphoneId || state.cameraId);
      try {
        // Both devices are opened once; the join policy decides what is
        // *enabled*, so unmuting later never re-prompts for permission.
        let stream: MediaStream;
        try {
          stream = await options.getUserMedia({
            audio: constrain(state.microphoneId),
            video: constrain(state.cameraId),
          });
        } catch (error) {
          // A device chosen in an earlier call may not be plugged in for this
          // one. Joining on the default beats joining with nothing.
          if (!remembered) throw error;
          stream = await options.getUserMedia({ audio: true, video: true });
          state = { ...state, microphoneId: undefined, cameraId: undefined };
          log.warn('a remembered device was gone; using the default', {
            reason: describeDeviceFailure(error),
          });
        }
        state = {
          stream,
          membershipId,
          cameraEnabled: preferences.camera,
          microphoneEnabled: preferences.microphone,
          muted: !preferences.microphone,
          ...(state.microphoneId ? { microphoneId: state.microphoneId } : {}),
          ...(state.cameraId ? { cameraId: state.cameraId } : {}),
          ...(state.speakerId ? { speakerId: state.speakerId } : {}),
        };
        applyTracks();
        log.info('camera and microphone started', {
          membershipId,
          camera: preferences.camera,
          microphone: preferences.microphone,
        });
      } catch (error) {
        state = {
          cameraEnabled: false,
          microphoneEnabled: false,
          muted: true,
          membershipId,
          error: describeDeviceFailure(error),
        };
        log.warn('could not open camera or microphone', { reason: state.error });
      }
      return publish();
    },

    setCamera(enabled) {
      state = { ...state, cameraEnabled: enabled && Boolean(state.stream) };
      applyTracks();
      return publish();
    },

    setMicrophone(enabled) {
      state = { ...state, microphoneEnabled: enabled && Boolean(state.stream) };
      applyTracks();
      return publish();
    },

    setMicrophoneDevice: (deviceId) => switchInput('audio', deviceId),
    setCameraDevice: (deviceId) => switchInput('video', deviceId),

    setSpeaker(deviceId) {
      // Output is not capture: there is no track and no sender involved, so
      // this cannot renegotiate anything even in principle.
      state = { ...state, ...(deviceId ? { speakerId: deviceId } : { speakerId: undefined }) };
      log.info('speaker chosen', { deviceId: deviceId ?? 'default' });
      return publish();
    },

    stop() {
      state.stream?.getTracks().forEach((track) => track.stop());
      // The devices are released; which ones the person chose is remembered,
      // so rejoining does not put them back on the built-in microphone.
      state = {
        cameraEnabled: false,
        microphoneEnabled: false,
        muted: true,
        ...(state.microphoneId ? { microphoneId: state.microphoneId } : {}),
        ...(state.cameraId ? { cameraId: state.cameraId } : {}),
        ...(state.speakerId ? { speakerId: state.speakerId } : {}),
      };
      log.info('camera and microphone released');
      return publish();
    },
  };
}

/** `true` for "whatever the system uses", or an exact device when one has been
 *  chosen. Exact so a stale id fails loudly and can fall back, rather than
 *  quietly capturing something else. */
function constrain(deviceId?: string): MediaTrackConstraints | true {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function describeDeviceFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  switch (name) {
    case 'NotAllowedError':
      return 'camera/microphone permission was refused - allow Layup in your OS privacy settings';
    case 'NotFoundError':
      return 'no camera or microphone was found on this machine';
    case 'NotReadableError':
      return 'the camera or microphone is already in use by another application';
    default:
      return message || 'camera/microphone could not be opened';
  }
}
