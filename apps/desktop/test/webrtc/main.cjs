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
  if (result.error) failures.push(result.error);
  if (!result.connected) failures.push('the two peers never reached connected');
  if (!result.gotTrack) failures.push('no video track arrived at the far side');
  if (result.receivedTrackKind !== 'video') failures.push(`unexpected track kind ${result.receivedTrackKind}`);
  if (!result.offers || !result.answers) failures.push('offer/answer did not complete');

  if (failures.length > 0) {
    console.error('WEBRTC FAILURES:\n' + failures.map((f) => ` - ${f}`).join('\n'));
    app.exit(1);
  } else {
    console.log('WEBRTC OK');
    app.exit(0);
  }
});
