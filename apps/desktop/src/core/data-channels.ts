/**
 * The three semantic data channels (ADR-0008, SPEC.md §11).
 *
 *   cursor-fast       unordered, lossy, latest-wins
 *   annotation-fast   loss-tolerant where practical
 *   input-reliable    ordered, reliable
 *
 * The split is the point: stale cursor motion is worse than lost cursor motion,
 * so cursor updates must never sit in a reliable queue waiting for a
 * retransmit, while a click or a keystroke must never be dropped.
 */
export const CHANNEL_CURSOR = 'cursor-fast';
export const CHANNEL_ANNOTATION = 'annotation-fast';
export const CHANNEL_INPUT = 'input-reliable';

export const CHANNEL_NAMES = [CHANNEL_CURSOR, CHANNEL_ANNOTATION, CHANNEL_INPUT] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

/**
 * Channel configuration. `maxRetransmits: 0` with `ordered: false` is what
 * makes a channel behave like unreliable UDP; leaving both unset gives the
 * reliable ordered default.
 */
export const CHANNEL_CONFIG: Record<ChannelName, RTCDataChannelInit> = {
  // Latest-wins: an old cursor position has no value once a newer one exists.
  [CHANNEL_CURSOR]: { ordered: false, maxRetransmits: 0, negotiated: true, id: 1 },
  // Drawing tolerates loss between strokes, but a couple of retransmits keep a
  // stroke from visibly breaking up on a lossy link.
  [CHANNEL_ANNOTATION]: { ordered: false, maxRetransmits: 2, negotiated: true, id: 2 },
  // Destructive actions: ordered and reliable, always.
  [CHANNEL_INPUT]: { ordered: true, negotiated: true, id: 3 },
};

export type ChannelHandler = (message: unknown, channel: ChannelName) => void;

export interface DataChannelSet {
  /** Sends on a channel. Returns false when it is not open yet. */
  send(channel: ChannelName, message: unknown): boolean;
  /** Subscribes to one channel. Returns an unsubscribe function. */
  on(channel: ChannelName, handler: ChannelHandler): () => void;
  /** Whether a channel is currently open. */
  isOpen(channel: ChannelName): boolean;
  /** How many messages were dropped because a channel was not open. */
  dropped(channel: ChannelName): number;
  close(): void;
}

export interface DataChannelOptions {
  createDataChannel: (label: string, init: RTCDataChannelInit) => RTCDataChannel;
  /**
   * Which of the three to open. All of them, unless a client has no business
   * with one: the web guest opens cursor and input but never annotation,
   * because a guest does not draw.
   *
   * The ids are negotiated and fixed, so leaving one out is safe in both
   * directions - the other side still opens its own on the same id, and the
   * messages it sends there simply land nowhere. Nothing shifts.
   */
  channels?: readonly ChannelName[];
  log?: {
    debug(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

const noopLog = { debug: () => {}, warn: () => {} };

/**
 * Opens the channels on a peer connection - all three, unless asked for fewer.
 *
 * They are negotiated (fixed ids agreed on both sides), so both peers open the
 * same channels without waiting for `ondatachannel` and without an extra
 * negotiation round trip. That is also why a client may open a subset: the ids
 * are fixed rather than assigned in order, so the ones it does open still line
 * up with the other side's.
 */
export function createDataChannels(options: DataChannelOptions): DataChannelSet {
  const log = options.log ?? noopLog;
  const channels = new Map<ChannelName, RTCDataChannel>();
  const handlers = new Map<ChannelName, Set<ChannelHandler>>();
  const drops = new Map<ChannelName, number>();
  const wanted = options.channels ?? CHANNEL_NAMES;

  for (const name of wanted) {
    const channel = options.createDataChannel(name, CHANNEL_CONFIG[name]);
    channel.onmessage = (event: MessageEvent) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        // A peer sending junk must not break the channel for everything else.
        log.warn('dropped unparseable data-channel message', { channel: name });
        return;
      }
      for (const handler of handlers.get(name) ?? []) {
        try {
          handler(payload, name);
        } catch (error) {
          log.warn('data-channel handler threw', {
            channel: name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    channels.set(name, channel);
  }

  return {
    send(name, message) {
      const channel = channels.get(name);
      if (!channel || channel.readyState !== 'open') {
        drops.set(name, (drops.get(name) ?? 0) + 1);
        return false;
      }
      channel.send(JSON.stringify(message));
      return true;
    },

    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },

    isOpen: (name) => channels.get(name)?.readyState === 'open',
    dropped: (name) => drops.get(name) ?? 0,

    close() {
      for (const channel of channels.values()) channel.close();
      channels.clear();
      handlers.clear();
    },
  };
}
