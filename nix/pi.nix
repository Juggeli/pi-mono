{
  lib,
  buildNpmPackage,
  bun,
  makeWrapper,
  autoPatchelfHook,
  stdenv,
  fd,
  ripgrep,
}:

buildNpmPackage {
  pname = "pi";
  version = "0.52.12";

  src = ./..;

  npmDepsHash = "sha256-pn3Kqf/mEOXvGNELML3NN4DeclZMtEzWpQIN+ud0W6M=";

  npmFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    bun
    makeWrapper
  ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
  ];

  dontNpmBuild = true;

  buildPhase = ''
    runHook preBuild

    # tsgo (native TS compiler preview) exits non-zero on some type errors
    # in the Nix sandbox, but still emits JS output (noEmitOnError is not set).
    # Wrap it to ignore the exit code.
    real_tsgo="$(readlink -f node_modules/.bin/tsgo)"
    rm node_modules/.bin/tsgo
    printf '#!/bin/sh\n"%s" "$@" || true\n' "$real_tsgo" > node_modules/.bin/tsgo
    chmod +x node_modules/.bin/tsgo

    # Skip generate-models in the ai package — it fetches from external APIs
    # which aren't available in the Nix sandbox. The checked-in
    # models.generated.ts is used instead.
    substituteInPlace packages/ai/package.json \
      --replace-fail '"build": "npm run generate-models && tsgo -p tsconfig.build.json"' \
                     '"build": "tsgo -p tsconfig.build.json"'

    npm run build

    # Stub out koffi before bun compile. Koffi is a native FFI module used only
    # for Windows VT input (enableWindowsVTInput has a try/catch). Its native
    # .node file can't be embedded in the bun bundle, so we replace it with a
    # stub that throws on use — caught by the existing error handling.
    echo 'module.exports = { load() { throw new Error("koffi stub"); } };' > node_modules/koffi/index.js

    cd packages/coding-agent
    bun build --compile ./dist/cli.js --outfile pi
    cd ../..

    runHook postBuild
  '';

  dontNpmInstall = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib/pi

    cp packages/coding-agent/pi $out/lib/pi/pi
    cp packages/coding-agent/package.json $out/lib/pi/
    cp node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm $out/lib/pi/

    mkdir -p $out/lib/pi/theme
    cp packages/coding-agent/dist/modes/interactive/theme/*.json $out/lib/pi/theme/

    cp -r packages/coding-agent/dist/core/export-html $out/lib/pi/
    cp -r packages/coding-agent/docs $out/lib/pi/
    cp -r packages/coding-agent/examples $out/lib/pi/

    makeWrapper $out/lib/pi/pi $out/bin/pi \
      --prefix PATH : ${lib.makeBinPath [ fd ripgrep ]} \
      --set PI_SKIP_VERSION_CHECK 1

    runHook postInstall
  '';

  meta = {
    description = "pi - coding agent CLI";
    license = lib.licenses.mit;
    mainProgram = "pi";
  };
}
