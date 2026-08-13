/**
 * Runs the WebRTC harness in a real Electron window and reports the result.
 *
 *   npm run test:webrtc --workspace apps/desktop
 *
 * Exits non-zero unless two peer connections built by the production module
 * actually connect and carry a real video track.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { writeFileSync } = require('node:fs');

app.disableHardwareAcceleration();
// Deterministic media in CI: no camera or microphone hardware required.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const harness = path.join(__dirname, '..', '..', 'dist', 'webrtc', 'harness.js');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
  });

  // A real page on the file:// origin, so the bundle loads like any script.
  const page = path.join(path.dirname(harness), 'index.html');
  writeFileSync(
    page,
    '<!doctype html><meta charset="utf-8"><title>layup webrtc</title><script src="./harness.js"></script>',
  );
  await win.loadFile(page);

  const result = await win.webContents.executeJavaScript(
    `(async () => {
       for (let i = 0; i < 400; i += 1) {
         if (window.__layupWebRTC) return await window.__layupWebRTC;
         if (window.__layupWebRTCError) return { error: window.__layupWebRTCError };
         await new Promise((resolve) => setTimeout(resolve, 50));
       }
       return { error: 'harness never started' };
     })()`,
  );

  console.log(JSON.stringify(result, null, 2));

  const failures = [];
  const direct = result.direct ?? {};
  const relay = result.forcedRelayWithoutTurn ?? {};

  if (result.error) failures.push(result.error);
  if (!direct.connected) failures.push('the two peers never reached connected');
  if (!direct.gotTrack) failures.push('no video track arrived at the far side');
  if (direct.receivedTrackKind !== 'video') failures.push(`unexpected track kind ${direct.receivedTrackKind}`);
  if (!direct.offers || !direct.answers) failures.push('offer/answer did not complete');

  // Forced relay must actually change behaviour: relay-only with no TURN
  // server must gather no host candidates and must not connect.
  if (relay.iceTransportPolicy !== 'relay') failures.push('forceRelay did not set iceTransportPolicy=relay');
  if (relay.connected) failures.push('relay-only connected with no TURN server - the policy was ignored');
  if (relay.hostCandidatesGathered !== 0) failures.push('relay-only gathered host candidates');

  // The shared desktop must arrive *and* decode: a track that never decodes is
  // a black screen share.
  const share = result.screenShare ?? {};
  if (!share.received) failures.push('the shared desktop never arrived at the far side');
  if (!share.decoded) failures.push('the shared desktop arrived but never decoded a frame');
  if (!(share.inbound && share.inbound.width > 0)) failures.push('decoded video had no dimensions');
  if (!share.connectedAfterUnpublish) failures.push('stopping the share tore down the connection');

  if (failures.length > 0) {
    console.error('WEBRTC FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    app.exit(1);
  } else {
    console.log('WEBRTC OK');
    app.exit(0);
  }
});
