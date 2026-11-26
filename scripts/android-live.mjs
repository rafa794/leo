// Live reload on an Android phone (or emulator) connected by USB: `npm run android:live`
//
// Installs "Orion Dev" (a separate app, next to the real Orion) that loads the editor straight from this
// computer's dev server through the USB cable (adb reverse). Every code change shows up on the phone at once.
// Chrome on the computer → chrome://inspect shows the phone's console.
//
// Needs: the phone with "USB debugging" on (Developer options), plugged in and authorized.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = 5173;
const SDK = process.env.ANDROID_HOME || join(homedir(), 'Library/Android/sdk');
const ADB = join(SDK, 'platform-tools/adb');
const JAVA_HOME = process.env.JAVA_HOME || '/opt/homebrew/opt/openjdk@21';
const APP_ID = 'app.orion.editor.dev';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

// 1. which phone
const devices = out(ADB, ['devices'])
  .split('\n')
  .slice(1)
  .map((l) => l.trim().split(/\s+/))
  .filter(([id, state]) => id && state === 'device')
  .map(([id]) => id);
const serial = process.env.ANDROID_SERIAL || devices.find((d) => !d.startsWith('emulator-')) || devices[0];
if (!serial) {
  console.error('No hay ningún móvil conectado. Activa «Depuración USB», conéctalo por cable y acepta el aviso en el móvil.');
  process.exit(1);
}
const adb = (...args) => run(ADB, ['-s', serial, ...args]);
console.log(`→ Móvil: ${serial}`);

// 2. the dev server (started here if it isn't running)
const up = async () => fetch(`http://localhost:${PORT}/`).then((r) => r.ok).catch(() => false);
let server = null;
if (!(await up())) {
  console.log('→ Arrancando el servidor de desarrollo…');
  server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: 'inherit' });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

// 3. build the dev app with the editor's address pointing at the dev server
run('npx', ['cap', 'sync', 'android']);
const cfgPath = 'android/app/src/main/assets/capacitor.config.json';
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
cfg.server = { ...(cfg.server ?? {}), url: `http://localhost:${PORT}`, cleartext: true };
writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
run('./gradlew', ['assembleDebug', '-q'], { cwd: 'android', env: { ...process.env, JAVA_HOME } });
const apk = 'android/app/build/outputs/apk/debug/app-debug.apk';
if (!existsSync(apk)) throw new Error('No se generó el APK de desarrollo');

// 4. install, connect the phone's localhost:5173 to this computer, open it
adb('install', '-r', apk);
adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
adb('shell', 'am', 'start', '-n', `${APP_ID}/app.orion.editor.MainActivity`);
console.log('\n✓ «Orion Dev» abierto en el móvil. Los cambios se ven al momento.');
console.log('  Consola del móvil: Chrome → chrome://inspect');
if (server) console.log('  (Ctrl+C para parar el servidor)');
else process.exit(0);
