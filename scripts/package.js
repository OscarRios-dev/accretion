// Builds a release for one platform and hardens the Electron binary with fuses.
//   node scripts/package.js [win32|darwin|linux] [x64|arm64]
const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || (platform === 'darwin' ? 'arm64' : 'x64');
const root = path.join(__dirname, '..');

// Only what the app needs at runtime ends up in the asar.
const KEEP = [/^\/package\.json$/, /^\/main\.js$/, /^\/preload\.js$/, /^\/scanner\.js$/, /^\/app(\/|$)/, /^\/examples(\/|$)/, /^\/LICENSE$/, /^\/THIRD_PARTY_NOTICES\.md$/];
const ignore = (p) => p !== '' && !KEEP.some((re) => re.test(p)) || /bundle\.js\.map$/.test(p);

(async () => {
  const [out] = await packager({
    dir: root,
    name: 'Accretion',
    platform,
    arch,
    out: path.join(root, 'dist', require('../package.json').version),
    overwrite: true,
    prune: true,
    ignore,
    asar: { unpackDir: 'examples' }, // the demo vault is read & watched as a normal folder
    // Icons come from build/make-icon.js (Linux takes its window icon from app/icon.png at runtime).
    icon: { win32: path.join(root, 'build', 'icon.ico'), darwin: path.join(root, 'build', 'icon.icns') }[platform],
    appCopyright: 'MIT License · Accretion contributors',
    win32metadata: { CompanyName: 'Accretion', FileDescription: 'Accretion', ProductName: 'Accretion' },
  });

  const exe = {
    win32: path.join(out, 'Accretion.exe'),
    linux: path.join(out, 'Accretion'),
    darwin: path.join(out, 'Accretion.app'),
  }[platform];
  // Fuses: no "run as plain Node", no NODE_OPTIONS, no --inspect, load only from the asar (with integrity on macOS).
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: platform === 'darwin',
    [FuseV1Options.EnableCookieEncryption]: true,
  });
  const size = fs.readdirSync(out).length;
  console.log(`Packaged ${platform}-${arch} → ${out} (${size} entries, fuses flipped)`);
})().catch((e) => { console.error(e); process.exit(1); });
