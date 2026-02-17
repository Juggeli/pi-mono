{ lib, stdenv }:

stdenv.mkDerivation {
  pname = "pi-extensions";
  version = "0.52.12";

  src = ../packages/coding-agent/built-in-extensions;

  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp synthetic.ts tps.ts ask-user.ts $out/
    runHook postInstall
  '';

  meta = {
    description = "pi custom extensions";
    license = lib.licenses.mit;
  };
}
