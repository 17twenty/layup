# Reference Projects / Ideas

Use these as architectural and UX references, not as requirements.

## Pop

- https://pop.com/
- Product reference for low-latency collaborative screen sharing, multi-user control, meeting UX and Screenhero lineage.

## Bananas

- https://github.com/mistweaverco/bananas
- Electron/P2P/multi-cursor ideas.
- MIT licensed at time of research; verify before copying code.

## Hopp

- https://github.com/gethopp/hopp
- Go backend + desktop remote collaboration + LiveKit/self-hosting ideas.
- AGPL-3.0 at time of research; treat as architectural reference unless project licensing is deliberately compatible.

## LiveKit

- https://github.com/livekit/livekit
- Candidate initial SFU for later multiparty stage.

## Pion WebRTC

- https://github.com/pion/webrtc
- Go WebRTC implementation/reference for protocol experiments and server-side understanding.

## coturn

- https://github.com/coturn/coturn
- TURN/STUN deployment. Do not reinvent this.

## RustDesk Server

- https://github.com/rustdesk/rustdesk-server
- Reference for rendezvous/relay separation and hostile-network self-hosting.

## Sunshine

- https://github.com/LizardByte/Sunshine
- Future reference if Chromium capture/encode becomes a demonstrated latency bottleneck.

## Licensing rule

Before copying implementation code from any reference project:

1. verify its current licence;
2. record the decision in an ADR;
3. ensure compatibility with Layup's intended licence;
4. prefer borrowing concepts/protocol ideas over copying implementation from copyleft projects unless deliberately approved.
