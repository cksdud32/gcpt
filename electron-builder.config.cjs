/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.gcpt.app",
  productName: "gcpt",
  directories: {
    output: "release",
  },
  files: [
    "out/**/*",
    "node_modules/**/*",
    "!node_modules/.cache/**/*",
  ],
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: null,
    createDesktopShortcut: true,
  },
  portable: {
    artifactName: "${productName}-${version}-portable.exe",
  },
};
