/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.gcpt.app",
  productName: "GCPT",
  copyright: "Copyright © 2025 gcpt",
  directories: {
    output: "release",
  },
  // out/ 빌드 결과 + externalizeDepsPlugin으로 외부화된 node_modules
  files: [
    "out/**/*",
    "node_modules/**/*",
    "!node_modules/.cache/**/*",
    "!node_modules/**/{*.map,*.ts,*.d.ts,*.md,*.markdown,README*,CHANGELOG*,test,tests,__tests__,spec,specs,*.test.js,*.spec.js}",
    "!node_modules/.bin/**/*",
  ],
  // asar: false → app.asar 패키징 생략, resources/app/ 디렉터리로 배포
  // ASAR integrity 업데이트(winCodeSign PE 수정)가 불필요해져서 심볼릭 링크 권한 오류 우회
  asar: false,
  win: {
    // zip은 make-zip.ps1 스크립트로 생성 (winCodeSign symlink 오류 우회)
    target: [
      { target: "dir", arch: ["x64"] },
    ],
    // rcedit(winCodeSign) 없이 빌드: PE 리소스 편집/코드서명 생략
    // Windows 개발자 모드 불필요, 개인 배포용으로는 영향 없음
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: "GCPT",
  },
};
