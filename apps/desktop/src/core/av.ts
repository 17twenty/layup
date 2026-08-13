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
}

export interface AvOptions {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  onChange?: (state: AvState) => void;
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

  return {
    state: () => state,

    async start(membershipId, preferences) {
      if (!membershipId) {
        state = { ...state, error: 'media needs a membership: accept first, then media starts' };
        return publish();
      }
      if (state.stream && state.membershipId === membershipId) return state;

      try {
        // Both devices are opened once; the join policy decides what is
        // *enabled*, so unmuting later never re-prompts for permission.
        const stream = await options.getUserMedia({ audio: true, video: true });
        state = {
          stream,
          membershipId,
          cameraEnabled: preferences.camera,
          microphoneEnabled: preferences.microphone,
          muted: !preferences.microphone,
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

    stop() {
      state.stream?.getTracks().forEach((track) => track.stop());
      state = { cameraEnabled: false, microphoneEnabled: false, muted: true };
      log.info('camera and microphone released');
      return publish();
    },
  };
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
